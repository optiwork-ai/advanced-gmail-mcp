import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  FORWARD_SEPARATOR,
  MEDIA_UPLOAD_THRESHOLD_BYTES,
  REFLOW_MIN_JOIN_LEN,
  buildForwardBlock,
  buildMimeMessage,
  buildQuoteBlock,
  encodeHeaderValue,
  escapeHtml,
  foldHeader,
  formatFromHeader,
  formatGmailDate,
  htmlToText,
  loadAttachment,
  MAX_ENCODED_MESSAGE_BYTES,
  MAX_TOTAL_ATTACHMENT_BYTES,
  mimeTypeForFilename,
  normalizeNewlines,
  parseAddress,
  reflowPlainText,
  sanitizeHeaderValue,
  textToHtml,
} from './mime.js';

function decode(rawBase64Url: string): string {
  return Buffer.from(rawBase64Url, 'base64url').toString('utf8');
}

/** Pull the decoded body of the Nth base64 part out of an assembled message. */
function decodeParts(raw: string): string[] {
  const out: string[] = [];
  const blocks = raw.split(/\r\n\r\n/);
  for (let i = 1; i < blocks.length; i++) {
    const candidate = blocks[i].split(/\r\n--/)[0];
    if (/^[A-Za-z0-9+/=\r\n]+$/.test(candidate) && candidate.trim().length > 0) {
      out.push(Buffer.from(candidate.replace(/\r\n/g, ''), 'base64').toString('utf8'));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------

describe('normalizeNewlines', () => {
  it('converts CRLF and bare CR to LF', () => {
    expect(normalizeNewlines('a\r\nb\rc\nd')).toBe('a\nb\nc\nd');
  });
});

describe('sanitizeHeaderValue', () => {
  it('replaces CR/LF with a space so no header can be injected', () => {
    expect(sanitizeHeaderValue('a@b.com\r\nBcc: evil@x.com')).toBe('a@b.com Bcc: evil@x.com');
  });

  it('strips NUL bytes', () => {
    expect(sanitizeHeaderValue('a\u0000b')).toBe('a b');
  });

  it('leaves a clean value untouched', () => {
    expect(sanitizeHeaderValue('Alice <alice@x.com>')).toBe('Alice <alice@x.com>');
  });
});

describe('reflowPlainText', () => {
  const wrapped = [
    'I want to flag a change that came out of my weekly integration call',
    'with Cotality (AppraisalPort) today. It affects how payment is handled',
    'on the new PennyMac Broker Direct 3.6 orders.',
  ].join('\n');

  it('joins a 70-column wrapped paragraph into one line', () => {
    const out = reflowPlainText(wrapped);
    expect(out.split('\n')).toHaveLength(1);
    expect(out).toContain('integration call with Cotality');
  });

  it('preserves blank-line paragraph breaks verbatim', () => {
    const out = reflowPlainText(`${wrapped}\n\n${wrapped}`);
    expect(out.split('\n')).toHaveLength(3);
    expect(out.split('\n')[1]).toBe('');
  });

  it.each(['- second item', '* second item', '1. second item', '2) second item', 'a) second item'])(
    'does not join before the list item %s',
    (item) => {
      const first = 'x'.repeat(70);
      expect(reflowPlainText(`${first}\n${item}`)).toBe(`${first}\n${item}`);
    },
  );

  it('does not join before a quoted line', () => {
    const first = 'x'.repeat(70);
    expect(reflowPlainText(`${first}\n> quoted`)).toBe(`${first}\n> quoted`);
  });

  it('does not join before an indented line', () => {
    const first = 'x'.repeat(70);
    expect(reflowPlainText(`${first}\n    indented`)).toBe(`${first}\n    indented`);
  });

  it('does not join after a line ending in a colon', () => {
    const label = `${'x'.repeat(69)}:`;
    expect(reflowPlainText(`${label}\nvalue`)).toBe(`${label}\nvalue`);
  });

  it('leaves a short line unjoined', () => {
    const short = 'x'.repeat(REFLOW_MIN_JOIN_LEN - 1);
    expect(reflowPlainText(`${short}\nnext`)).toBe(`${short}\nnext`);
  });

  it('joins at exactly the threshold length', () => {
    const atThreshold = 'x'.repeat(REFLOW_MIN_JOIN_LEN);
    expect(reflowPlainText(`${atThreshold}\nnext`)).toBe(`${atThreshold} next`);
  });

  it('is idempotent', () => {
    const once = reflowPlainText(`${wrapped}\n\nHi Steve,\n\n${wrapped}`);
    expect(reflowPlainText(once)).toBe(once);
  });

  it('handles empty and single-line input', () => {
    expect(reflowPlainText('')).toBe('');
    expect(reflowPlainText('just one line')).toBe('just one line');
  });

  // Whole-paragraph classification (chair ruling Q2+Q15, Option B). A paragraph
  // reflows only when EVERY line except the last clears the threshold and no
  // per-line guard vetoes a seam; otherwise it is left byte-for-byte alone.
  const signOff = [
    'Thanks for sending over the updated appraisal report yesterday afternoon.',
    'Steve Angelo',
    'Appraisal Host',
    '555-1234',
  ].join('\n');

  it('leaves a typed sign-off block verbatim under a long line', () => {
    expect(reflowPlainText(signOff)).toBe(signOff);
  });

  it('is idempotent on a paragraph it declines to reflow', () => {
    const once = reflowPlainText(signOff);
    expect(reflowPlainText(once)).toBe(once);
  });

  it('leaves the whole paragraph verbatim when an interior line is short', () => {
    const long = 'x'.repeat(70);
    const input = `${long}\nshort\n${long}\ntail`;
    expect(reflowPlainText(input)).toBe(input);
  });

  it('reflows when only the final line is short', () => {
    const long = 'x'.repeat(70);
    expect(reflowPlainText(`${long}\n${long}\ntail`)).toBe(`${long} ${long} tail`);
  });

  it('lets one vetoed seam block the whole paragraph, not just that seam', () => {
    const long = 'x'.repeat(70);
    const input = `${long}\n${long}\n- item`;
    expect(reflowPlainText(input)).toBe(input);
  });

  it('classifies each paragraph independently', () => {
    const long = 'x'.repeat(70);
    const out = reflowPlainText(`${long}\n${long}\ntail\n\n${signOff}`);
    expect(out).toBe(`${long} ${long} tail\n\n${signOff}`);
  });
});

describe('escapeHtml', () => {
  it('escapes the five entities in order', () => {
    expect(escapeHtml(`& < > " '`)).toBe('&amp; &lt; &gt; &quot; &#39;');
  });
});

describe('textToHtml', () => {
  it('wraps in a Gmail-shaped div', () => {
    expect(textToHtml('hello')).toBe('<div dir="ltr">hello</div>');
  });

  it('turns a newline into <br> and a blank line into two', () => {
    expect(textToHtml('a\nb')).toBe('<div dir="ltr">a<br>b</div>');
    expect(textToHtml('a\n\nb')).toBe('<div dir="ltr">a<br><br>b</div>');
  });

  it('escapes markup in the source text', () => {
    expect(textToHtml('<b>&')).toBe('<div dir="ltr">&lt;b&gt;&amp;</div>');
  });

  it('links a bare URL', () => {
    expect(textToHtml('see https://example.com/x now')).toContain(
      '<a href="https://example.com/x">https://example.com/x</a>',
    );
  });

  it('excludes a trailing period from the link', () => {
    const out = textToHtml('see https://example.com/x.');
    expect(out).toContain('<a href="https://example.com/x">https://example.com/x</a>.');
  });

  it('excludes a trailing paren from the link', () => {
    const out = textToHtml('(https://example.com/x)');
    expect(out).toContain('<a href="https://example.com/x">https://example.com/x</a>)');
  });

  it('links a bare www. host with an http:// scheme', () => {
    expect(textToHtml('go to www.example.com now')).toContain(
      '<a href="http://www.example.com">www.example.com</a>',
    );
  });

  it('links an email address as mailto', () => {
    expect(textToHtml('mail alice@example.com please')).toContain(
      '<a href="mailto:alice@example.com">alice@example.com</a>',
    );
  });

  it('does not double-link an email inside an already-linked URL', () => {
    const out = textToHtml('https://example.com/u/alice@example.com done');
    expect(out.match(/<a /g)).toHaveLength(1);
  });

  it('stops the link at a quote instead of swallowing the entity', () => {
    // Escaping runs before autolinking, so by the time the URL regex sees the
    // text the excluded characters are `&quot;` / `&lt;` — every character of
    // which the regex used to accept. `Visit "https://x.com" now` produced an
    // href ending in `&quot` with a stray `;` outside the anchor.
    const out = textToHtml('Visit "https://example.com" now');
    expect(out).toContain('<a href="https://example.com">https://example.com</a>');
    expect(out).not.toContain('&quot<');
    expect(out).not.toContain('&quot"');
  });

  it('stops the link at an escaped angle bracket', () => {
    const out = textToHtml('see http://x.com<b>bold</b> and done');
    expect(out).toContain('<a href="http://x.com">http://x.com</a>&lt;b&gt;');
  });

  it('keeps a query string with an ampersand inside the link', () => {
    const out = textToHtml('open https://example.com/s?a=1&b=2 now');
    expect(out).toContain(
      '<a href="https://example.com/s?a=1&amp;b=2">https://example.com/s?a=1&amp;b=2</a>',
    );
  });

  it('stops a www. link at a quote too', () => {
    const out = textToHtml('Visit "www.example.com" now');
    expect(out).toContain('<a href="http://www.example.com">www.example.com</a>');
    expect(out).not.toContain('&quot<');
  });
});

describe('htmlToText', () => {
  it('converts <br> to a newline', () => {
    expect(htmlToText('a<br>b')).toBe('a\nb');
  });

  it('converts </p> and </div> to newlines', () => {
    expect(htmlToText('<p>a</p><div>b</div>')).toBe('a\nb');
  });

  it('renders list items with a dash', () => {
    expect(htmlToText('<ul><li>one</li><li>two</li></ul>')).toBe('- one\n- two');
  });

  it('renders an anchor as TEXT <URL>', () => {
    expect(htmlToText('<a href="https://x.com">click</a>')).toBe('click <https://x.com>');
  });

  it('emits a self-labelled anchor once', () => {
    expect(htmlToText('<a href="https://x.com">https://x.com</a>')).toBe('https://x.com');
  });

  it('decodes entities', () => {
    expect(htmlToText('a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39;&nbsp;f')).toBe(
      `a & b <c> "d" 'e' f`,
    );
  });

  it('strips script and style content', () => {
    expect(htmlToText('<style>p{color:red}</style>hi<script>alert(1)</script>')).toBe('hi');
  });

  it('collapses three or more newlines to two', () => {
    expect(htmlToText('a<br><br><br><br>b')).toBe('a\n\nb');
  });

  it('does not end the anchor tag at a > inside an attribute value', () => {
    // `[^>]*` for the attribute run ended the match at the first `>` anywhere in
    // the tag, so `a>b">label` leaked raw attribute text into the plain text.
    expect(htmlToText(`<a href='http://q.com' title="a>b">label</a>`)).toBe(
      'label <http://q.com>',
    );
    expect(htmlToText(`<a data-x="p>q" href="http://r.com">label</a>`)).toBe(
      'label <http://r.com>',
    );
  });

  it('cannot have its anchor placeholder forged by the source document', () => {
    // The placeholder used to be a fixed `\0ANCHOR<n>\0`, so source HTML
    // containing that sequence duplicated or deleted content. (The NULs are
    // written as escapes so git still reads this file as text.)
    const forged = `${'\u0000'}ANCHOR0${'\u0000'}`;
    expect(htmlToText(`<a href="http://real.com">real</a> ${forged} tail`)).toBe(
      'real <http://real.com> ANCHOR0 tail',
    );
    expect(htmlToText(`${forged} <a href="http://a.com">a</a>`)).toBe(
      'ANCHOR0 a <http://a.com>',
    );
  });

  it('round-trips a textToHtml body', () => {
    expect(htmlToText(textToHtml('Hello there.\n\nSecond paragraph.'))).toBe(
      'Hello there.\n\nSecond paragraph.',
    );
  });
});

describe('formatGmailDate', () => {
  it('renders the Gmail shape with a narrow no-break space before AM', () => {
    expect(formatGmailDate('2026-08-21T11:27:00.000Z', 'America/New_York')).toBe(
      'Fri, Aug 21, 2026 at 7:27 AM',
    );
  });

  it('renders midnight as 12:00\u202FAM', () => {
    expect(formatGmailDate('2026-08-21T04:00:00.000Z', 'America/New_York')).toContain(
      '12:00 AM',
    );
  });

  it('renders noon as 12:00\u202FPM', () => {
    expect(formatGmailDate('2026-08-21T16:00:00.000Z', 'America/New_York')).toContain(
      '12:00 PM',
    );
  });

  it('falls back to the raw string for an unparseable date', () => {
    expect(formatGmailDate('not a date')).toBe('not a date');
  });

  it('accepts a Date instance', () => {
    expect(formatGmailDate(new Date('2026-08-21T11:27:00.000Z'), 'UTC')).toBe(
      'Fri, Aug 21, 2026 at 11:27 AM',
    );
  });
});

describe('parseAddress', () => {
  it('splits a Name <addr> pair', () => {
    expect(parseAddress('Cathy Mason <cathy@x.com>')).toEqual({
      name: 'Cathy Mason',
      email: 'cathy@x.com',
    });
  });

  it('unquotes a quoted display name', () => {
    expect(parseAddress('"Mason, Cathy" <cathy@x.com>').name).toBe('Mason, Cathy');
  });

  it('returns a bare address with an empty name', () => {
    expect(parseAddress('cathy@x.com')).toEqual({ name: '', email: 'cathy@x.com' });
  });
});

describe('formatFromHeader', () => {
  it('renders Name <addr> for a plain display name', () => {
    expect(formatFromHeader('Steve', 'steve@appraisalhost.com')).toBe(
      'Steve <steve@appraisalhost.com>',
    );
  });

  it('returns the bare address when the display name is empty', () => {
    expect(formatFromHeader('', 'x@y.com')).toBe('x@y.com');
  });

  it('quotes a display name containing specials', () => {
    expect(formatFromHeader('Mason, Cathy', 'c@x.com')).toBe('"Mason, Cathy" <c@x.com>');
  });

  it('RFC 2047-encodes a non-ASCII display name', () => {
    expect(formatFromHeader('José', 'j@x.com')).toBe(
      `${encodeHeaderValue('José')} <j@x.com>`,
    );
  });
});

describe('foldHeader', () => {
  it('leaves a short header on one line', () => {
    expect(foldHeader('To', 'alice@x.com')).toBe('To: alice@x.com');
  });

  it('folds a six-ID References chain with CRLF + TAB', () => {
    const ids = Array.from({ length: 6 }, (_, i) => `<message-id-number-${i}@mail.gmail.com>`);
    const folded = foldHeader('References', ids.join(' '));
    expect(folded).toContain('\r\n\t');
    for (const line of folded.split('\r\n')) {
      expect(line.length).toBeLessThanOrEqual(78);
    }
    expect(folded.replace(/\r\n\t/g, ' ')).toBe(`References: ${ids.join(' ')}`);
  });

  it('never splits an individual encoded-word across a fold', () => {
    const encoded = encodeHeaderValue('a very long subject line with lots of accents: éééééééééééééééééééééééééééééé');
    const folded = foldHeader('Subject', encoded);
    // A long value becomes SEVERAL encoded-words (RFC 2047 caps one at 75
    // characters), so the folded header need not contain the joined string —
    // but every individual word must survive intact on some line.
    for (const word of encoded.split(' ')) {
      expect(folded).toContain(word);
    }
    expect(folded.replace(/\r\n\t/g, ' ')).toBe(`Subject: ${encoded}`);
  });
});

describe('encodeHeaderValue — RFC 2047 length', () => {
  it('emits one encoded-word for a short non-ASCII value', () => {
    expect(encodeHeaderValue('Café ☕')).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
  });

  it.each([50, 200, 400, 600, 1200])(
    'caps every encoded-word at 75 characters for a %i-character value',
    (n) => {
      const words = encodeHeaderValue('é'.repeat(n)).split(' ');
      for (const word of words) {
        expect(word).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
        expect(word.length).toBeLessThanOrEqual(75);
      }
    },
  );

  it('round-trips a long mixed value through the encoded-word sequence', () => {
    const value = `Ré: ${'é'.repeat(400)} tail`;
    const decoded = encodeHeaderValue(value)
      .split(' ')
      .map(word => Buffer.from(word.slice(10, -2), 'base64').toString('utf8'))
      .join('');
    expect(decoded).toBe(value);
  });

  it('never splits a multi-byte character across two encoded-words', () => {
    const value = '👋'.repeat(60); // 4 bytes each, so the chunk edge lands mid-emoji
    const decoded = encodeHeaderValue(value)
      .split(' ')
      .map(word => Buffer.from(word.slice(10, -2), 'base64').toString('utf8'))
      .join('');
    expect(decoded).toBe(value);
    expect(decoded).not.toContain('�');
  });

  it('keeps a long non-ASCII Subject line under 998 octets in the assembled message', () => {
    const raw = buildMimeMessage({
      to: 'a@b.com',
      subject: `Ré: ${'é'.repeat(600)}`,
      body: 'hello',
    }).raw;
    for (const line of raw.split('\r\n')) {
      expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(998);
    }
    // And the folded Subject still decodes back to what was asked for.
    const subjectLine = raw.split('\r\n\r\n')[0]
      .split(/\r\n(?!\t)/)
      .find(line => line.startsWith('Subject:')) as string;
    const decoded = subjectLine
      .replace(/^Subject: /, '')
      .split(/\s+/)
      .map(word => Buffer.from(word.slice(10, -2), 'base64').toString('utf8'))
      .join('');
    expect(decoded).toBe(`Ré: ${'é'.repeat(600)}`);
  });
});

describe('buildQuoteBlock', () => {
  const base = {
    date: '2026-08-21T11:27:00.000Z',
    html: '<div dir="ltr">Original body</div>',
    text: 'Original body',
    timeZone: 'America/New_York',
  };

  it('builds the attribution with a display name', () => {
    const { html } = buildQuoteBlock({ ...base, from: 'Cathy Mason <cathy@x.com>' });
    expect(html).toContain(
      'class="gmail_attr">On Fri, Aug 21, 2026 at 7:27 AM Cathy Mason '
      + '&lt;<a href="mailto:cathy@x.com">cathy@x.com</a>&gt; wrote:<br></div>',
    );
  });

  it('builds the attribution without a display name', () => {
    const { html } = buildQuoteBlock({ ...base, from: 'cathy@x.com' });
    expect(html).toContain('<a href="mailto:cathy@x.com">cathy@x.com</a> wrote:');
    expect(html).not.toContain('&lt;<a');
  });

  it('emits the byte-exact blockquote style', () => {
    const { html } = buildQuoteBlock({ ...base, from: 'cathy@x.com' });
    expect(html).toContain(
      '<blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;'
      + 'border-left:1px solid rgb(204,204,204);padding-left:1ex">',
    );
    expect(html.startsWith('<br><div class="gmail_quote gmail_quote_container">')).toBe(true);
    expect(html.endsWith('</blockquote></div>')).toBe(true);
  });

  it('prefixes every quoted text line, blank lines as a bare >', () => {
    const { text } = buildQuoteBlock({
      ...base,
      from: 'cathy@x.com',
      text: 'one\n\ntwo',
    });
    expect(text.endsWith('> one\n>\n> two')).toBe(true);
    expect(text.startsWith('\n\nOn Fri, Aug 21, 2026 at 7:27 AM <cathy@x.com> wrote:\n\n')).toBe(true);
  });

  it('falls back to textToHtml when the original has no HTML body', () => {
    const { html } = buildQuoteBlock({ ...base, from: 'c@x.com', html: '' });
    expect(html).toContain('<div dir="ltr">Original body</div>');
  });

  it('falls back to htmlToText when the original has no text body', () => {
    const { text } = buildQuoteBlock({ ...base, from: 'c@x.com', text: '' });
    expect(text).toContain('> Original body');
  });
});

describe('buildForwardBlock', () => {
  const base = {
    originalFrom: 'Domino Holmes <dholmes@cotality.com>',
    originalDate: '2026-08-13T21:26:00.000Z',
    originalSubject: 'Invoice 42',
    originalTo: 'steve@appraisalhost.com',
    originalHtml: '<div dir="ltr">Original</div>',
    originalText: 'Original',
    timeZone: 'America/New_York',
  };

  it('uses the separator with exactly nine trailing dashes', () => {
    expect(FORWARD_SEPARATOR).toBe('---------- Forwarded message ---------');
    const { text } = buildForwardBlock(base);
    expect(text.split('\n')[0]).toBe('---------- Forwarded message ---------');
  });

  it('renders the text header block with a Gmail-shaped date', () => {
    const { text } = buildForwardBlock(base);
    const lines = text.split('\n');
    expect(lines[1]).toBe('From: Domino Holmes <dholmes@cotality.com>');
    expect(lines[2]).toBe('Date: Thu, Aug 13, 2026 at 5:26 PM');
    expect(lines[3]).toBe('Subject: Invoice 42');
    expect(lines[4]).toBe('To: steve@appraisalhost.com');
    expect(lines[5]).toBe('');
    expect(lines[6]).toBe('');
    expect(lines[7]).toBe('Original');
  });

  it('omits the Cc line when there is no Cc', () => {
    expect(buildForwardBlock(base).text).not.toContain('Cc:');
    expect(buildForwardBlock(base).html).not.toContain('CC:');
  });

  it('includes Cc in the text flavour and CC in the HTML flavour', () => {
    const withCc = buildForwardBlock({ ...base, originalCc: 'carol@x.com' });
    expect(withCc.text).toContain('Cc: carol@x.com');
    expect(withCc.html).toContain('<br>CC: <a href="mailto:carol@x.com">carol@x.com</a>');
  });

  it('marks the sender name with gmail_sendername in the HTML flavour', () => {
    expect(buildForwardBlock(base).html).toContain(
      '<strong class="gmail_sendername" dir="auto">Domino Holmes</strong>',
    );
  });

  it('emits no raw newline inside the HTML attribution div', () => {
    const { html } = buildForwardBlock(base);
    const attr = html.slice(0, html.indexOf('</div><br>'));
    expect(attr).not.toContain('\n');
  });

  it('does not wrap forwarded content in a blockquote', () => {
    expect(buildForwardBlock(base).html).not.toContain('<blockquote');
  });
});

describe('buildMimeMessage', () => {
  it('assembles multipart/alternative with the text part before the HTML part', () => {
    const raw = decode(
      buildMimeMessage({ to: 'a@b.com', subject: 'Hi', body: 'Hello' }).rawBase64Url,
    );
    expect(raw).toContain('Content-Type: multipart/alternative');
    expect(raw.indexOf('Content-Type: text/plain')).toBeLessThan(
      raw.indexOf('Content-Type: text/html'),
    );
  });

  it('uses the boundary exactly three times for a two-part alternative', () => {
    const raw = decode(
      buildMimeMessage({ to: 'a@b.com', subject: 'Hi', body: 'Hello' }).rawBase64Url,
    );
    const boundary = raw.match(/boundary="([^"]+)"/)![1];
    expect(raw.split(`--${boundary}`)).toHaveLength(4); // 3 delimiters
  });

  it('base64-encodes parts at 76 characters per line', () => {
    const raw = decode(
      buildMimeMessage({ to: 'a@b.com', subject: 'Hi', body: 'x'.repeat(3000) }).rawBase64Url,
    );
    expect(raw).toContain('Content-Transfer-Encoding: base64');
    const b64Lines = raw.split('\r\n').filter(l => /^[A-Za-z0-9+/=]{40,}$/.test(l));
    expect(b64Lines.length).toBeGreaterThan(1);
    for (const line of b64Lines) expect(line.length).toBeLessThanOrEqual(76);
  });

  it('keeps every line under the 998-octet RFC 5322 limit for a 5,000-char body', () => {
    const raw = decode(
      buildMimeMessage({ to: 'a@b.com', subject: 'Hi', body: 'x'.repeat(5000) }).rawBase64Url,
    );
    for (const line of raw.split('\r\n')) {
      expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(998);
    }
  });

  it('generates an HTML alternative from a plain-text body', () => {
    const built = buildMimeMessage({ to: 'a@b.com', subject: 'Hi', body: 'Hello\nthere' });
    const parts = decodeParts(built.raw);
    expect(parts[0]).toBe('Hello\nthere');
    expect(parts[1]).toBe('<div dir="ltr">Hello<br>there</div>');
  });

  it('generates a text alternative from an HTML body and leaves the HTML verbatim', () => {
    const built = buildMimeMessage({
      to: 'a@b.com',
      subject: 'Hi',
      body: '<div dir="ltr">Hello<br>there</div>',
      is_html: true,
    });
    const parts = decodeParts(built.raw);
    expect(parts[0]).toBe('Hello\nthere');
    expect(parts[1]).toBe('<div dir="ltr">Hello<br>there</div>');
  });

  it('appends the html_suffix and text_suffix to their own parts', () => {
    const built = buildMimeMessage({
      to: 'a@b.com',
      subject: 'Hi',
      body: 'Hello',
      html_suffix: '<div class="gmail_signature">sig</div>',
      text_suffix: '\n\nsig',
    });
    const parts = decodeParts(built.raw);
    expect(parts[0].endsWith('\n\nsig')).toBe(true);
    expect(parts[1].endsWith('<div class="gmail_signature">sig</div>')).toBe(true);
  });

  it('reflows a plain-text body by default and not when reflow is false', () => {
    const wrapped = `${'x'.repeat(70)}\nsecond line`;
    expect(decodeParts(buildMimeMessage({ to: 'a', subject: 's', body: wrapped }).raw)[0])
      .toBe(`${'x'.repeat(70)} second line`);
    expect(
      decodeParts(buildMimeMessage({ to: 'a', subject: 's', body: wrapped, reflow: false }).raw)[0],
    ).toBe(wrapped);
  });

  it('emits Reply-To when set and omits it otherwise', () => {
    const withReplyTo = decode(
      buildMimeMessage({ to: 'a@b.com', subject: 'Hi', body: 'x', reply_to: 'r@x.com' }).rawBase64Url,
    );
    expect(withReplyTo).toContain('Reply-To: r@x.com');
    expect(
      decode(buildMimeMessage({ to: 'a@b.com', subject: 'Hi', body: 'x' }).rawBase64Url),
    ).not.toContain('Reply-To:');
  });

  it('emits a legacy single-part text/plain message for plain_text_only', () => {
    const raw = decode(
      buildMimeMessage({
        from: 'me@x.com',
        to: 'list@x.com',
        subject: 'Unsubscribe',
        body: 'Unsubscribe',
        plain_text_only: true,
      }).rawBase64Url,
    );
    expect(raw).toBe(
      'From: me@x.com\r\nTo: list@x.com\r\nSubject: Unsubscribe\r\n'
      + 'MIME-Version: 1.0\r\nContent-Type: text/plain; charset="UTF-8"\r\n\r\nUnsubscribe',
    );
  });

  it('RFC 2047-encodes a non-ASCII subject', () => {
    const raw = decode(
      buildMimeMessage({ to: 'a@b.com', subject: 'Café ☕', body: 'x' }).rawBase64Url,
    );
    expect(raw).toContain(`Subject: ${encodeHeaderValue('Café ☕')}`);
  });

  it('strips CRLF out of every caller-supplied header value', () => {
    const raw = decode(
      buildMimeMessage({
        from: 'me@x.com\r\nX-Evil: 1',
        to: 'a@b.com\r\nBcc: evil@x.com',
        cc: 'c@x.com\r\nX-Evil: 2',
        bcc: 'b@x.com\r\nX-Evil: 3',
        reply_to: 'r@x.com\r\nX-Evil: 4',
        subject: 'Hi\r\nX-Evil: 5',
        body: 'x',
      }).rawBase64Url,
    );
    const headerBlock = raw.split('\r\n\r\n')[0];
    expect(headerBlock).not.toMatch(/^X-Evil:/m);
    expect(headerBlock.split('\r\n').filter(l => /^Bcc:/.test(l))).toEqual([
      'Bcc: b@x.com X-Evil: 3',
    ]);
  });

  it('wraps the alternative in multipart/mixed when there are attachments', () => {
    const built = buildMimeMessage({
      to: 'a@b.com',
      subject: 'Hi',
      body: 'x',
      attachments: [
        { filename: 'report.pdf', mimeType: 'application/pdf', content: Buffer.from('PDFDATA') },
      ],
    });
    const raw = decode(built.rawBase64Url);
    expect(raw).toContain('Content-Type: multipart/mixed');
    expect(raw.indexOf('multipart/alternative')).toBeLessThan(raw.indexOf('report.pdf'));
    expect(raw).toContain('Content-Disposition: attachment; filename="report.pdf"');
    expect(raw).toContain('Content-Type: application/pdf; name="report.pdf"');
  });

  it('emits both filename= and filename*= for a non-ASCII attachment name', () => {
    const raw = decode(
      buildMimeMessage({
        to: 'a@b.com',
        subject: 'Hi',
        body: 'x',
        attachments: [
          { filename: 'rapport-é.pdf', mimeType: 'application/pdf', content: Buffer.from('X') },
        ],
      }).rawBase64Url,
    );
    expect(raw).toContain(`filename="rapport-_.pdf"`);
    expect(raw).toContain(`filename*=UTF-8''rapport-%C3%A9.pdf`);
  });

  it("percent-encodes the RFC 2231 characters encodeURIComponent leaves alone", () => {
    // encodeURIComponent leaves ' ! ( ) * unescaped. RFC 2231's ext-value
    // requires anything outside attribute-char to be percent-encoded, and a
    // literal ' in particular can confuse a parser splitting on the
    // charset'language'value delimiters.
    const raw = decode(
      buildMimeMessage({
        to: 'a@b.com',
        subject: 'Hi',
        body: 'x',
        attachments: [
          { filename: `o'brien (é)!*.pdf`, mimeType: 'application/pdf', content: Buffer.from('X') },
        ],
      }).rawBase64Url,
    );
    const extValue = raw.match(/filename\*=UTF-8''(\S+)/)?.[1] as string;
    expect(extValue).not.toMatch(/['!()*]/);
    expect(decodeURIComponent(extValue)).toBe(`o'brien (é)!*.pdf`);
  });

  it('refuses a mimeType that is not a MIME token rather than corrupting the part', () => {
    const raw = decode(
      buildMimeMessage({
        to: 'a@b.com',
        subject: 'Hi',
        body: 'x',
        attachments: [
          { filename: 'ok.txt', mimeType: 'text/plain\r\nX-Evil: 1', content: Buffer.from('X') },
        ],
      }).rawBase64Url,
    );
    expect(raw).toContain('Content-Type: application/octet-stream; name="ok.txt"');
    expect(raw).not.toContain('X-Evil');
  });

  it('keeps the type when a mimeType carries parameters', () => {
    const raw = decode(
      buildMimeMessage({
        to: 'a@b.com',
        subject: 'Hi',
        body: 'x',
        attachments: [
          { filename: 'ok.txt', mimeType: 'text/plain; charset=utf-8', content: Buffer.from('X') },
        ],
      }).rawBase64Url,
    );
    expect(raw).toContain('Content-Type: text/plain; name="ok.txt"');
  });

  it('rejects attachments totalling more than 25MB', () => {
    expect(() =>
      buildMimeMessage({
        to: 'a@b.com',
        subject: 'Hi',
        body: 'x',
        attachments: [
          { filename: 'a.bin', mimeType: 'application/octet-stream', content: Buffer.alloc(20 * 1000 * 1000) },
          { filename: 'b.bin', mimeType: 'application/octet-stream', content: Buffer.alloc(6 * 1000 * 1000) },
        ],
      }),
    ).toThrow(/Attachments total 26\.0MB; Gmail's limit is 25MB/);
  });

  it('refuses plain_text_only with attachments rather than dropping them', () => {
    // The single-part path returns before any attachment part is emitted AND
    // before the total-size gate, so this used to build a 90-byte message with
    // the attachment silently discarded and no error of any kind.
    expect(() =>
      buildMimeMessage({
        to: 'a@b.com',
        subject: 'Hi',
        body: 'x',
        plain_text_only: true,
        attachments: [
          { filename: 'secret.pdf', mimeType: 'application/pdf', content: Buffer.alloc(1024) },
        ],
      }),
    ).toThrow(/plain_text_only.*cannot carry attachments/i);
  });

  it('still builds a plain_text_only message with no attachments', () => {
    const built = buildMimeMessage({
      to: 'a@b.com',
      subject: 'Hi',
      body: 'x',
      plain_text_only: true,
      attachments: [],
    });
    expect(built.raw).toContain('Content-Type: text/plain; charset="UTF-8"');
  });

  it('accepts the full advertised 25MB of attachments', () => {
    // The whole point of the limit is that it is reachable. Before this was
    // fixed the total gate measured MiB while the message ceiling measured
    // decimal MB, so anything near 25MB died at the ceiling instead — with an
    // error that read "Assembled message is 34.2MB, over the 35MB ceiling."
    const built = buildMimeMessage({
      to: 'a@b.com',
      subject: 'Hi',
      body: 'x',
      attachments: [
        {
          filename: 'big.bin',
          mimeType: 'application/octet-stream',
          content: Buffer.alloc(MAX_TOTAL_ATTACHMENT_BYTES),
        },
      ],
    });
    expect(built.bytes).toBeLessThanOrEqual(MAX_ENCODED_MESSAGE_BYTES);
  });

  it('reports the assembled size in the same units as the ceiling it names', () => {
    // A message that lands just over 35,000,000 bytes. Reported in MiB it read
    // "34.1MB, over the 35MB ceiling" — a sentence that says 34.1 exceeds 35.
    let message = '';
    try {
      buildMimeMessage({
        to: 'a@b.com',
        subject: 'Hi',
        body: 'x'.repeat(600_000),
        attachments: [
          {
            filename: 'big.bin',
            mimeType: 'application/octet-stream',
            content: Buffer.alloc(25_000_000),
          },
        ],
      });
    } catch (err) {
      message = (err as Error).message;
    }
    const reported = Number(message.match(/Assembled message is ([\d.]+)MB/)?.[1]);
    expect(reported).toBeGreaterThan(35);
  });

  it('reports a size that crosses the media-upload threshold', () => {
    const built = buildMimeMessage({
      to: 'a@b.com',
      subject: 'Hi',
      body: 'x',
      attachments: [
        { filename: 'big.bin', mimeType: 'application/octet-stream', content: Buffer.alloc(6 * 1024 * 1024) },
      ],
    });
    expect(built.bytes).toBeGreaterThan(MEDIA_UPLOAD_THRESHOLD_BYTES);
    expect(built.bytes).toBe(Buffer.byteLength(built.raw, 'utf8'));
  });
});

describe('mimeTypeForFilename', () => {
  it.each([
    ['a.pdf', 'application/pdf'],
    ['a.PNG', 'image/png'],
    ['a.jpg', 'image/jpeg'],
    ['a.jpeg', 'image/jpeg'],
    ['a.csv', 'text/csv'],
    ['a.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['a.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['a.ics', 'text/calendar'],
    ['a.unknownext', 'application/octet-stream'],
    ['noextension', 'application/octet-stream'],
  ])('maps %s', (name, expected) => {
    expect(mimeTypeForFilename(name)).toBe(expected);
  });
});

describe('loadAttachment', () => {
  const created: string[] = [];

  afterEach(() => {
    for (const f of created.splice(0)) {
      try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
    }
  });

  function tmpFile(name: string, contents: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-mcp-att-'));
    const full = path.join(dir, name);
    fs.writeFileSync(full, contents);
    created.push(full);
    return full;
  }

  it('rejects a relative path', async () => {
    await expect(loadAttachment('relative/file.pdf')).rejects.toThrow(
      /Attachment path must be absolute/,
    );
  });

  it('rejects a missing file', async () => {
    await expect(loadAttachment('/nonexistent/definitely/missing.pdf')).rejects.toThrow(
      /Attachment not found/,
    );
  });

  it('rejects a directory', async () => {
    await expect(loadAttachment(os.tmpdir())).rejects.toThrow(/not a regular file/);
  });

  it('loads a file with its basename and mapped MIME type', async () => {
    const file = tmpFile('quote.csv', 'a,b\n1,2\n');
    const att = await loadAttachment(file);
    expect(att.filename).toBe('quote.csv');
    expect(att.mimeType).toBe('text/csv');
    expect(att.content.toString()).toBe('a,b\n1,2\n');
  });
});
