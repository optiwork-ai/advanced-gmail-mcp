/**
 * MIME assembly for Gmail-native outbound mail.
 *
 * Everything in this module is pure and network-free so it can be unit-tested
 * exhaustively. `client.ts` stays a thin API layer on top of it.
 *
 * Shapes here were taken from real Gmail-composed mail in the owner's mailbox
 * (see review-outbound.md §A3/§A4), not from memory: the `gmail_quote`
 * container, the `gmail_attr` attribution with U+202F before AM/PM, the
 * nine-trailing-dash forwarded-message separator, and the `<div dir="ltr">`
 * body wrapper are all byte-shapes copied from verified samples.
 */
import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import type { Attachment } from './types.js';

export type { Attachment };

const CRLF = '\r\n';

/** RFC 5322 recommends folding headers at 78 columns (the hard cap is 998). */
const MAX_HEADER_LINE = 78;

/** Base64 body lines are chunked at 76 characters (RFC 2045). */
const BASE64_LINE_LEN = 76;

/**
 * All three ceilings below are DECIMAL megabytes, and they have to be: the
 * assembled-message ceiling is compared against the attachment budget after
 * base64 inflation (~1.37x with the CRLF line breaks), so mixing MiB and MB
 * makes them silently inconsistent. It did: with the attachment budget in MiB
 * and the message ceiling in decimal MB, a 25 MiB attachment cleared the "25MB
 * total" gate and then died at the message ceiling with "Assembled message is
 * 34.2MB, over the 35MB ceiling" — a sentence claiming 34.2 exceeds 35, and an
 * advertised 25MB allowance that could never actually be used.
 *
 * 25,000,000 raw bytes inflate to ~34.2M, which fits under the 35,000,000
 * ceiling with room for the headers and the body parts.
 */

/** Per-file attachment ceiling — Gmail's own limit. */
export const MAX_ATTACHMENT_BYTES = 25_000_000;

/** Total raw attachment bytes allowed on one message. */
export const MAX_TOTAL_ATTACHMENT_BYTES = 25_000_000;

/** Hard ceiling on the assembled message; beyond this Gmail will reject it. */
export const MAX_ENCODED_MESSAGE_BYTES = 35_000_000;

/**
 * Messages at or below this size go through `requestBody.raw`; larger ones use
 * the resumable/media upload path. See review-outbound.md §B4.
 */
export const MEDIA_UPLOAD_THRESHOLD_BYTES = 5_000_000;

/**
 * Minimum length of a line before the reflow pass will join it to the next one.
 *
 * Evidence (review-outbound.md §A1): the composing model's hard wrap lands at
 * exactly 70 columns in live sent mail, while genuinely authored short lines
 * (greetings, sign-offs, list items) sit well under 60. 60 separates the two
 * populations with margin on both sides.
 */
export const REFLOW_MIN_JOIN_LEN = 60;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface MimeOptions {
  to: string;
  subject: string;
  body: string;
  /** Full `Name <email>` — the caller composes it (see formatFromHeader). */
  from?: string;
  cc?: string;
  bcc?: string;
  /** Interpret `body` as HTML markup rather than plain text. */
  is_html?: boolean;
  in_reply_to?: string;
  references?: string;
  reply_to?: string;
  /** Signature + quote/forward block, HTML flavour. Appended to the HTML part. */
  html_suffix?: string;
  /** Signature + quote/forward block, text flavour. Appended to the text part. */
  text_suffix?: string;
  attachments?: Attachment[];
  /** Legacy single-part `text/plain` escape hatch (unsubscribe mailto path). */
  plain_text_only?: boolean;
  /** Undo composer hard-wrapping. Defaults to true when !is_html. */
  reflow?: boolean;
}

export interface BuiltMessage {
  /** The assembled RFC 5322 message, CRLF line endings throughout. */
  raw: string;
  /** The same message base64url-encoded for `requestBody.raw`. */
  rawBase64Url: string;
  /** Byte length of `raw` — the number the transport decision is made on. */
  bytes: number;
}

// ---------------------------------------------------------------------------
// Text primitives
// ---------------------------------------------------------------------------

export function normalizeNewlines(s: string): string {
  return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Strip CR/LF (and NUL) out of a header value.
 *
 * Header injection guard: without this, a `to` of "a@b.com\r\nBcc: evil@x.com"
 * becomes a real Bcc header and silently blind-copies an attacker. Line breaks
 * are replaced with a single space so the value stays one physical line and no
 * two tokens are silently welded together.
 */
export function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n\u0000]+/g, ' ').trim();
}

/** RFC 2047: an encoded-word may not exceed 75 characters, delimiters included. */
const MAX_ENCODED_WORD = 75;
const ENCODED_WORD_OVERHEAD = '=?UTF-8?B?'.length + '?='.length; // 12
/** Base64 chars that fit, rounded down to a whole quantum. */
const ENCODED_WORD_B64_CHARS =
  Math.floor((MAX_ENCODED_WORD - ENCODED_WORD_OVERHEAD) / 4) * 4; // 60
/** ...and the raw UTF-8 bytes those encode. */
const ENCODED_WORD_RAW_BYTES = (ENCODED_WORD_B64_CHARS / 4) * 3; // 45

function encodedWord(chunk: string): string {
  return `=?UTF-8?B?${Buffer.from(chunk, 'utf-8').toString('base64')}?=`;
}

/**
 * RFC 2047 encoded-word(s) for header values containing non-ASCII characters.
 * Returns the value untouched when it's pure ASCII.
 *
 * A long value becomes SEVERAL space-separated encoded-words, which is the
 * whole reason RFC 2047 caps a word at 75 characters: an encoded-word contains
 * no whitespace, so `foldHeader` cannot break one, and a single unbroken word
 * for a 400-character subject produced a 1,097-octet `Subject:` line — past the
 * 998-octet hard cap of RFC 5322. Splitting here is what actually retires that
 * defect on the header side; base64 body encoding only retires it for bodies.
 *
 * Chunks are cut on codepoint boundaries (RFC 2047 requires each word to encode
 * an integral number of characters), and whitespace BETWEEN adjacent
 * encoded-words is discarded by the decoder, so the value round-trips exactly.
 */
export function encodeHeaderValue(value: string): string {
  if (/^[\x00-\x7F]*$/.test(value)) return value;

  const words: string[] = [];
  let chunk = '';
  let chunkBytes = 0;
  for (const char of value) {
    const size = Buffer.byteLength(char, 'utf-8');
    if (chunkBytes > 0 && chunkBytes + size > ENCODED_WORD_RAW_BYTES) {
      words.push(encodedWord(chunk));
      chunk = '';
      chunkBytes = 0;
    }
    chunk += char;
    chunkBytes += size;
  }
  if (chunk.length > 0) words.push(encodedWord(chunk));

  return words.join(' ');
}

/**
 * Fold a long header at the last whitespace before column 78, continuing with
 * a single TAB. An RFC 2047 encoded-word contains no whitespace, so it is a
 * single token here and can never be split across a fold.
 */
export function foldHeader(name: string, value: string): string {
  const single = `${name}: ${value}`;
  if (single.length <= MAX_HEADER_LINE) return single;

  const tokens = value.split(/\s+/).filter(t => t.length > 0);
  if (tokens.length === 0) return single;

  const lines: string[] = [];
  let current = `${name}:`;
  let currentIsEmpty = true;

  for (const token of tokens) {
    if (currentIsEmpty) {
      current += ` ${token}`;
      currentIsEmpty = false;
      continue;
    }
    if (current.length + 1 + token.length > MAX_HEADER_LINE) {
      lines.push(current);
      current = `\t${token}`;
    } else {
      current += ` ${token}`;
    }
  }
  lines.push(current);
  return lines.join(CRLF);
}

/**
 * Compose a `From`/sender header from a display name and an address.
 * An empty display name yields the bare address (today's behavior).
 */
export function formatFromHeader(displayName: string, email: string): string {
  const addr = sanitizeHeaderValue(email || '');
  const name = sanitizeHeaderValue(displayName || '');
  if (!name) return addr;
  const encoded = encodeHeaderValue(name);
  // A quoted-string is required when an ASCII display name contains specials.
  if (encoded === name && /[()<>@,;:\\".\[\]]/.test(name)) {
    return `"${name.replace(/(["\\])/g, '\\$1')}" <${addr}>`;
  }
  return `${encoded} <${addr}>`;
}

/** Split a `Name <addr>` header value into its parts. */
export function parseAddress(raw: string): { name: string; email: string } {
  const match = raw.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  if (match) {
    const name = match[1].trim().replace(/^"(.*)"$/, '$1');
    return { name, email: match[2].trim() };
  }
  return { name: '', email: raw.trim() };
}

// ---------------------------------------------------------------------------
// Reflow — undo composer hard-wrapping without destroying real structure
// ---------------------------------------------------------------------------

const LIST_ITEM_RE = /^\s*([-*•–—]|\d+[.)]|[A-Za-z][.)])\s/;
const QUOTED_RE = /^\s*>/;
const INDENTED_RE = /^\s{2,}\S/;

function canJoin(current: string, next: string): boolean {
  const trimmed = current.trimEnd();
  if (trimmed.length < REFLOW_MIN_JOIN_LEN) return false;
  if (trimmed.endsWith(':')) return false;
  if (LIST_ITEM_RE.test(next)) return false;
  if (QUOTED_RE.test(next)) return false;
  if (INDENTED_RE.test(next)) return false;
  return true;
}

/**
 * Join lines that were hard-wrapped by a composing model back into paragraphs.
 * Blank lines are preserved verbatim as paragraph separators. Idempotent.
 */
export function reflowPlainText(text: string): string {
  const lines = normalizeNewlines(text).split('\n');
  const out: string[] = [];

  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim() === '') {
      out.push(lines[i]);
      i++;
      continue;
    }

    let current = lines[i];
    i++;
    while (i < lines.length && lines[i].trim() !== '') {
      if (canJoin(current, lines[i])) {
        current = `${current.trimEnd()} ${lines[i].trim()}`;
      } else {
        out.push(current);
        current = lines[i];
      }
      i++;
    }
    out.push(current);
  }

  return out.join('\n');
}

// ---------------------------------------------------------------------------
// text <-> html
// ---------------------------------------------------------------------------

/**
 * Autolinking runs on text that has ALREADY been HTML-escaped, so excluding the
 * literal characters `<`, `>` and `"` is not enough: by the time these regexes
 * run those characters are `&lt;`, `&gt;` and `&quot;`, and every character of
 * an entity is URL-legal. `Visit "https://example.com" now` used to produce an
 * href ending in `&quot` with a stray `;` left outside the anchor.
 *
 * So the character class excludes `&` as well, and re-admits exactly one
 * entity: `&amp;`, which is what a legitimate query-string `&` escapes to.
 */
const URL_CHAR = '(?:&amp;|[^\\s<>"&])';
const URL_LAST = '(?:&amp;|[^\\s<>"&.,;:!?)\\]])';
const URL_RE = new RegExp(`\\bhttps?:\\/\\/${URL_CHAR}+${URL_LAST}`, 'g');
const WWW_RE = new RegExp(`\\bwww\\.${URL_CHAR}+${URL_LAST}`, 'g');
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const ANCHOR_SPLIT_RE = /(<a\b[^>]*>[\s\S]*?<\/a>)/g;

/** Run a linking pass only on the segments that are not already inside an <a>. */
function linkPass(input: string, re: RegExp, href: (match: string) => string): string {
  return input
    .split(ANCHOR_SPLIT_RE)
    .map((segment, idx) => {
      if (idx % 2 === 1) return segment; // an existing anchor — leave it alone
      return segment.replace(re, match => `<a href="${href(match)}">${match}</a>`);
    })
    .join('');
}

function autolink(escaped: string): string {
  let out = linkPass(escaped, URL_RE, m => m);
  out = linkPass(out, WWW_RE, m => `http://${m}`);
  out = linkPass(out, EMAIL_RE, m => `mailto:${m}`);
  return out;
}

/**
 * Convert plain text to Gmail's own HTML shape: a `<div dir="ltr">` wrapper
 * with `<br>` line breaks and autolinked URLs/emails.
 */
export function textToHtml(text: string): string {
  const escaped = escapeHtml(normalizeNewlines(text));
  const linked = autolink(escaped);
  return `<div dir="ltr">${linked.split('\n').join('<br>')}</div>`;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec) => safeCodePoint(Number(dec)))
    // &amp; last, so "&amp;lt;" does not decode twice.
    .replace(/&amp;/gi, '&');
}

function safeCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/**
 * Convert HTML to a readable plain-text alternative. Deterministic, no DOM.
 */
export function htmlToText(html: string): string {
  let s = normalizeNewlines(html);
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  // `<li>` opens the marker and `</li>` closes the line — emitting a newline on
  // both would double-space every list.
  s = s.replace(/<li\b[^>]*>/gi, '- ');
  s = s.replace(/<\/(p|div|tr|li)\s*>/gi, '\n');

  // Anchors resolve to `TEXT <URL>`, which itself looks like a tag. Park them
  // behind sentinels so the tag-stripping pass below cannot eat the URL.
  const anchors: string[] = [];
  s = s.replace(
    /<a\b[^>]*\bhref\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_match, href: string, inner: string) => {
      const url = decodeEntities(href).trim();
      const label = decodeEntities(inner.replace(/<[^>]*>/g, '')).trim();
      const rendered = !label || label === url ? url : `${label} <${url}>`;
      anchors.push(rendered);
      return `\u0000ANCHOR${anchors.length - 1}\u0000`;
    },
  );
  s = s.replace(/<[^>]*>/g, '');
  s = decodeEntities(s);
  s = s.replace(/\u0000ANCHOR(\d+)\u0000/g, (_m, idx) => anchors[Number(idx)] ?? '');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/**
 * Render a date the way Gmail does in quote/forward attributions:
 * `Fri, Aug 21, 2026 at 7:27\u202FAM` — note U+202F (narrow no-break space)
 * before AM/PM, which is what Gmail itself emits.
 * An unparseable date falls back to the raw header string.
 */
export function formatGmailDate(input: string | Date, tz?: string): string {
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) {
    return typeof input === 'string' ? input : '';
  }

  const timeZone = tz ?? process.env.GMAIL_MCP_TZ ?? undefined;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone,
    }).formatToParts(date);
  } catch {
    return typeof input === 'string' ? input : date.toISOString();
  }

  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find(p => p.type === type)?.value ?? '';

  return `${get('weekday')}, ${get('month')} ${get('day')}, ${get('year')}`
    + ` at ${get('hour')}:${get('minute')}\u202F${get('dayPeriod')}`;
}

// ---------------------------------------------------------------------------
// Quote / forward blocks
// ---------------------------------------------------------------------------

export interface QuoteBlockOptions {
  /** The original `From` header, e.g. `Cathy Mason <cathy@example.com>`. */
  from: string;
  /** The original `Date` header (or any parseable date). */
  date: string;
  /** The original HTML body, if any. */
  html: string;
  /** The original text body, if any. */
  text: string;
  timeZone?: string;
}

const BLOCKQUOTE_OPEN =
  '<blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;'
  + 'border-left:1px solid rgb(204,204,204);padding-left:1ex">';

function mailtoLink(email: string): string {
  const safe = escapeHtml(email);
  return `<a href="mailto:${safe}">${safe}</a>`;
}

function attributionHtml(from: string): string {
  const { name, email } = parseAddress(from);
  return name
    ? `${escapeHtml(name)} &lt;${mailtoLink(email)}&gt;`
    : mailtoLink(email);
}

function attributionText(from: string): string {
  const { name, email } = parseAddress(from);
  return name ? `${name} <${email}>` : `<${email}>`;
}

/** Prefix every line with "> " (blank lines become a bare ">"). */
function quoteText(text: string): string {
  return normalizeNewlines(text)
    .split('\n')
    .map(line => (line.length === 0 ? '>' : `> ${line}`))
    .join('\n');
}

/**
 * Build Gmail's quoted-history block for a reply, in both flavours.
 */
export function buildQuoteBlock(opts: QuoteBlockOptions): { html: string; text: string } {
  const date = formatGmailDate(opts.date, opts.timeZone);
  const originalHtml = opts.html && opts.html.trim().length > 0
    ? opts.html
    : textToHtml(opts.text ?? '');
  const originalText = opts.text && opts.text.trim().length > 0
    ? opts.text
    : htmlToText(opts.html ?? '');

  const html =
    '<br><div class="gmail_quote gmail_quote_container">'
    + `<div dir="ltr" class="gmail_attr">On ${date} ${attributionHtml(opts.from)}`
    + ' wrote:<br></div>'
    + BLOCKQUOTE_OPEN
    + originalHtml
    + '</blockquote></div>';

  const text = `\n\nOn ${date} ${attributionText(opts.from)} wrote:\n\n${quoteText(originalText)}`;

  return { html, text };
}

/**
 * Gmail's forwarded-message separator: ten leading dashes, NINE trailing.
 * Verified across six independent Gmail-native forwards (review-outbound.md §A4).
 */
export const FORWARD_SEPARATOR = '---------- Forwarded message ---------';

export interface ForwardBlockOptions {
  originalFrom: string;
  originalDate: string;
  originalSubject: string;
  originalTo: string;
  originalCc?: string;
  originalHtml: string;
  originalText: string;
  timeZone?: string;
}

function linkRecipients(list: string): string {
  return list
    .split(',')
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0)
    .map(entry => {
      const { name, email } = parseAddress(entry);
      return name
        ? `${escapeHtml(name)} &lt;${mailtoLink(email)}&gt;`
        : mailtoLink(email);
    })
    .join(', ');
}

/**
 * Build Gmail's forwarded-message block in both flavours.
 *
 * Unlike a reply, a forward gets NO blockquote — the forwarded content sits
 * directly inside the `gmail_quote` container. The Cc label is `CC:` in the
 * HTML flavour and `Cc:` in the text flavour; that is Gmail's own
 * inconsistency and it is matched deliberately.
 */
export function buildForwardBlock(opts: ForwardBlockOptions): { html: string; text: string } {
  const date = formatGmailDate(opts.originalDate, opts.timeZone);
  const { name, email } = parseAddress(opts.originalFrom);

  const textLines = [
    FORWARD_SEPARATOR,
    `From: ${name ? `${name} <${email}>` : email}`,
    `Date: ${date}`,
    `Subject: ${opts.originalSubject}`,
    `To: ${opts.originalTo}`,
  ];
  if (opts.originalCc && opts.originalCc.trim().length > 0) {
    textLines.push(`Cc: ${opts.originalCc}`);
  }

  const originalText = opts.originalText && opts.originalText.trim().length > 0
    ? opts.originalText
    : htmlToText(opts.originalHtml ?? '');
  const originalHtml = opts.originalHtml && opts.originalHtml.trim().length > 0
    ? opts.originalHtml
    : textToHtml(opts.originalText ?? '');

  const text = `${textLines.join('\n')}\n\n\n${originalText}`;

  let attrHtml =
    '<br><div class="gmail_quote gmail_quote_container">'
    + '<div dir="ltr" class="gmail_attr">'
    + FORWARD_SEPARATOR
    + '<br>From: <strong class="gmail_sendername" dir="auto">'
    + escapeHtml(name || email)
    + '</strong> <span dir="auto">&lt;'
    + mailtoLink(email)
    + '&gt;</span>'
    + `<br>Date: ${date}`
    + `<br>Subject: ${escapeHtml(opts.originalSubject)}`
    + `<br>To: ${linkRecipients(opts.originalTo)}`;
  if (opts.originalCc && opts.originalCc.trim().length > 0) {
    attrHtml += `<br>CC: ${linkRecipients(opts.originalCc)}`;
  }
  attrHtml += '</div><br>';

  return { html: `${attrHtml}${originalHtml}</div>`, text };
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

const EXT_MIME: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  txt: 'text/plain',
  csv: 'text/csv',
  md: 'text/markdown',
  json: 'application/json',
  xml: 'application/xml',
  html: 'text/html',
  zip: 'application/zip',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  mp4: 'video/mp4',
  mp3: 'audio/mpeg',
  ics: 'text/calendar',
};

export function mimeTypeForFilename(filename: string): string {
  const ext = path.extname(filename).replace(/^\./, '').toLowerCase();
  return EXT_MIME[ext] ?? 'application/octet-stream';
}

/** Decimal MB, matching the units every ceiling in this module is stated in. */
function mb(bytes: number): string {
  return (bytes / 1_000_000).toFixed(1);
}

/** Strip characters that would break a MIME parameter or a header line. */
export function sanitizeFilename(filename: string): string {
  return filename.replace(/[\r\n"]/g, '').trim() || 'attachment';
}

/**
 * Read a file from disk into an in-memory attachment.
 * Absolute paths only, regular files only, 25MB per file.
 */
export async function loadAttachment(filePath: string): Promise<Attachment> {
  if (!path.isAbsolute(filePath)) {
    throw new Error(`Attachment path must be absolute: ${filePath}`);
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    throw new Error(`Attachment not found: ${filePath}`);
  }
  if (!stat.isFile()) {
    throw new Error(`Attachment is not a regular file: ${filePath}`);
  }
  if (stat.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(
      `Attachment ${path.basename(filePath)} is ${mb(stat.size)}MB; the per-file limit is 25MB.`,
    );
  }

  const filename = sanitizeFilename(path.basename(filePath));
  return {
    filename,
    mimeType: mimeTypeForFilename(filename),
    content: fs.readFileSync(filePath),
  };
}

// ---------------------------------------------------------------------------
// Message assembly
// ---------------------------------------------------------------------------

let boundaryCounter = 0;

function makeBoundary(children: string[]): string {
  for (let attempt = 0; attempt < 2; attempt++) {
    boundaryCounter += 1;
    const candidate = `----=_Part_${boundaryCounter}_${randomBytes(12).toString('hex')}`;
    if (!children.some(child => child.includes(candidate))) return candidate;
  }
  // Astronomically unreachable; a distinct suffix guarantees termination.
  return `----=_Part_${boundaryCounter}_${randomBytes(18).toString('hex')}`;
}

function base64Body(content: Buffer | string): string {
  const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  const encoded = buf.toString('base64');
  const lines: string[] = [];
  for (let i = 0; i < encoded.length; i += BASE64_LINE_LEN) {
    lines.push(encoded.slice(i, i + BASE64_LINE_LEN));
  }
  return lines.join(CRLF);
}

function isAscii(s: string): boolean {
  return /^[\x00-\x7F]*$/.test(s);
}

function attachmentPart(att: Attachment, boundary: string): string {
  const filename = sanitizeFilename(att.filename);
  const mimeType = sanitizeHeaderValue(att.mimeType || 'application/octet-stream');

  let contentType: string;
  let disposition: string;
  if (isAscii(filename)) {
    contentType = `Content-Type: ${mimeType}; name="${filename}"`;
    disposition = `Content-Disposition: attachment; filename="${filename}"`;
  } else {
    // RFC 2231 for the disposition, RFC 2047 for the (display-only) name param.
    const fallback = filename.replace(/[^\x00-\x7F]/g, '_');
    const encoded = encodeURIComponent(filename);
    contentType = `Content-Type: ${mimeType}; name="${encodeHeaderValue(filename)}"`;
    disposition =
      `Content-Disposition: attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
  }

  return [
    `--${boundary}`,
    contentType,
    disposition,
    'Content-Transfer-Encoding: base64',
    '',
    base64Body(att.content),
  ].join(CRLF);
}

function buildAlternative(textBody: string, htmlBody: string): { boundary: string; content: string } {
  const textPart = base64Body(textBody);
  const htmlPart = base64Body(htmlBody);
  const boundary = makeBoundary([textPart, htmlPart]);

  // RFC 2046: least-faithful representation first, so text precedes HTML.
  const content = [
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    textPart,
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    htmlPart,
    `--${boundary}--`,
  ].join(CRLF);

  return { boundary, content };
}

/**
 * Assemble the outbound message.
 *
 * Body rules (review-outbound.md §B1b): normalize newlines; `is_html` selects
 * how `body` is interpreted, never the container; suffixes carry the signature
 * and the quote/forward block; the result is `multipart/alternative`, wrapped
 * in `multipart/mixed` when there are attachments.
 */
export function buildMimeMessage(opts: MimeOptions): BuiltMessage {
  const bodySource = normalizeNewlines(opts.body ?? '');

  let htmlBody: string;
  let textBody: string;
  if (opts.is_html === true) {
    htmlBody = bodySource;
    textBody = htmlToText(bodySource);
  } else {
    const textCore = opts.reflow === false ? bodySource : reflowPlainText(bodySource);
    htmlBody = textToHtml(textCore);
    textBody = textCore;
  }
  htmlBody += opts.html_suffix ?? '';
  textBody += opts.text_suffix ?? '';

  const headers: string[] = [];
  const addHeader = (name: string, value: string | undefined, fold = false): void => {
    if (value === undefined || value === null) return;
    const clean = sanitizeHeaderValue(String(value));
    if (clean.length === 0) return;
    headers.push(fold ? foldHeader(name, clean) : `${name}: ${clean}`);
  };

  addHeader('From', opts.from);
  headers.push(foldHeader('To', sanitizeHeaderValue(opts.to ?? '')));
  addHeader('Cc', opts.cc, true);
  addHeader('Bcc', opts.bcc, true);
  addHeader('Reply-To', opts.reply_to);
  headers.push(
    foldHeader('Subject', encodeHeaderValue(sanitizeHeaderValue(opts.subject ?? ''))),
  );
  addHeader('In-Reply-To', opts.in_reply_to);
  addHeader('References', opts.references, true);
  headers.push('MIME-Version: 1.0');

  const attachments = opts.attachments ?? [];

  if (opts.plain_text_only === true) {
    // Byte-identical to the legacy single-part message (unsubscribe mailto path).
    headers.push('Content-Type: text/plain; charset="UTF-8"');
    return finalize(`${headers.join(CRLF)}${CRLF}${CRLF}${textBody}`, attachments);
  }

  const alternative = buildAlternative(textBody, htmlBody);

  if (attachments.length === 0) {
    headers.push(`Content-Type: multipart/alternative; boundary="${alternative.boundary}"`);
    return finalize(`${headers.join(CRLF)}${CRLF}${CRLF}${alternative.content}`, attachments);
  }

  const totalRaw = attachments.reduce((sum, a) => sum + a.content.length, 0);
  if (totalRaw > MAX_TOTAL_ATTACHMENT_BYTES) {
    throw new Error(
      `Attachments total ${mb(totalRaw)}MB; Gmail's limit is 25MB of files per message.`,
    );
  }

  const outer = makeBoundary([alternative.content]);
  const sections = [
    `--${outer}`,
    `Content-Type: multipart/alternative; boundary="${alternative.boundary}"`,
    '',
    alternative.content,
    ...attachments.map(att => attachmentPart(att, outer)),
    `--${outer}--`,
  ];
  headers.push(`Content-Type: multipart/mixed; boundary="${outer}"`);

  return finalize(`${headers.join(CRLF)}${CRLF}${CRLF}${sections.join(CRLF)}`, attachments);
}

/**
 * Encode the assembled message and enforce the ceiling Gmail will accept.
 * Checked on every path, not just the attachment one, so an oversized pasted
 * body fails here with a clear message rather than as an opaque API error.
 */
function finalize(raw: string, attachments: Attachment[]): BuiltMessage {
  const bytes = Buffer.byteLength(raw, 'utf8');
  if (bytes > MAX_ENCODED_MESSAGE_BYTES) {
    const detail = attachments.length > 0
      ? ` Attachments: ${attachments.map(a => `${a.filename} (${mb(a.content.length)}MB)`).join(', ')}.`
      : '';
    throw new Error(
      `Assembled message is ${mb(bytes)}MB, over the 35MB ceiling.${detail}`,
    );
  }
  return {
    raw,
    rawBase64Url: Buffer.from(raw, 'utf8').toString('base64url'),
    bytes,
  };
}
