import { promises as fsp } from 'fs';
import * as path from 'path';
import { Readable } from 'stream';
import { google } from 'googleapis';
import type { gmail_v1 } from 'googleapis';
import type { Auth } from 'googleapis';
import { type AccountConfig, resolveAccount } from '../config.js';
import { getAuthClient } from './auth.js';
import { log } from '../log.js';
import {
  MEDIA_UPLOAD_THRESHOLD_BYTES,
  type BuiltMessage,
  type MimeOptions,
  buildForwardBlock,
  buildMimeMessage,
  buildQuoteBlock,
  formatFromHeader,
  htmlToText,
  loadAttachment,
  sanitizeFilename,
} from './mime.js';
import { getSendAsProfile } from './settings.js';
import type {
  Attachment,
  DraftPage,
  EmailSummary,
  EmailFull,
  EmailHeadersOnly,
  MessagePage,
  AttachmentInfo,
  AttachmentData,
  ThreadInfo,
  ThreadMessage,
  LabelInfo,
  SendResult,
  DraftResult,
  DraftSummary,
  DraftFull,
  ModifyResult,
  BatchResult,
  UnsubscribeResult,
} from './types.js';

/**
 * RFC 2047 header encoding lives in mime.ts now; it is re-exported here so the
 * existing call sites and its unit tests keep importing it from this module.
 */
export { encodeHeaderValue } from './mime.js';

// ---------------------------------------------------------------------------
// Client cache: OAuth2Client per account with 50-min TTL
// ---------------------------------------------------------------------------

interface CachedClient {
  client: Auth.OAuth2Client;
  gmail: gmail_v1.Gmail;
  expiresAt: number;
}

const CLIENT_CACHE = new Map<string, CachedClient>();
const CLIENT_TTL_MS = 50 * 60 * 1000; // 50 minutes

/**
 * Get an authenticated Gmail API client for an account.
 * Caches OAuth2Client per account with 50-min TTL.
 */
export async function getGmailClient(account?: string | AccountConfig): Promise<gmail_v1.Gmail> {
  const resolved = typeof account === 'string' || account === undefined
    ? resolveAccount(account)
    : account;

  const cacheKey = resolved.email;
  const cached = CLIENT_CACHE.get(cacheKey);

  if (cached && Date.now() < cached.expiresAt) {
    return cached.gmail;
  }

  const authClient = await getAuthClient(resolved);
  const gmail = google.gmail({ version: 'v1', auth: authClient });

  CLIENT_CACHE.set(cacheKey, {
    client: authClient,
    gmail,
    expiresAt: Date.now() + CLIENT_TTL_MS,
  });

  return gmail;
}

// ---------------------------------------------------------------------------
// Retry helper for rate limits
// ---------------------------------------------------------------------------

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { maxRetries?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 3;
  const sleep = opts.sleep ?? defaultSleep;
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastError = err;
      const status = (err as any)?.code || (err as any)?.response?.status;

      if (status === 401 || status === 403) {
        const message = err instanceof Error ? err.message : String(err);
        log('error', 'auth_error', { status, message });
        throw new Error(
          `Authentication error (${status}): ${message}\n\n` +
          `Re-authenticate with: npx tsx src/auth.ts <account-alias>`
        );
      }

      if (RETRYABLE_STATUSES.has(status) && attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
        log('warn', 'retry', { status, attempt: attempt + 1, delay_ms: delay });
        await sleep(delay);
        continue;
      }

      throw err;
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// Header / body extraction helpers
// ---------------------------------------------------------------------------

function extractHeader(
  headers: Array<{ name?: string | null; value?: string | null }>,
  name: string,
): string {
  const header = headers.find(h => h.name?.toLowerCase() === name.toLowerCase());
  return header?.value || '';
}

function decodeBase64Url(data: string): string {
  const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(base64, 'base64').toString('utf-8');
}

/**
 * Extract the message's own HTML and plain-text body from a MIME payload.
 *
 * First-wins at the shallowest depth (defect F5). The previous last-wins walk
 * descended into `message/rfc822` sub-messages and into inline alternatives
 * inside quoted history, so a message that already contained a forwarded
 * sub-message could report the NESTED original as its body — which every
 * quote and forward feature would then inherit.
 *
 * Exported for unit testing.
 */
export function extractBody(payload: gmail_v1.Schema$MessagePart): { html: string; text: string } {
  // An attached file is never the message body, even when it is text/*.
  if (payload.filename && payload.filename.length > 0) {
    return { html: '', text: '' };
  }

  if (payload.mimeType === 'text/html' && payload.body?.data) {
    return { html: decodeBase64Url(payload.body.data), text: '' };
  }
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return { html: '', text: decodeBase64Url(payload.body.data) };
  }

  let html = '';
  let text = '';

  if (payload.parts) {
    for (const part of payload.parts) {
      // A nested message is quoted history, not this message's body.
      if (part.mimeType === 'message/rfc822') continue;
      if (part.filename && part.filename.length > 0) continue;

      const result = extractBody(part);
      if (!html && result.html) html = result.html;
      if (!text && result.text) text = result.text;
      if (html && text) break;
    }
  }

  return { html, text };
}

/**
 * Extract attachment metadata from message parts (no content download).
 */
function extractAttachments(payload: gmail_v1.Schema$MessagePart): AttachmentInfo[] {
  const attachments: AttachmentInfo[] = [];

  if (payload.filename && payload.filename.length > 0 && payload.body?.attachmentId) {
    attachments.push({
      attachmentId: payload.body.attachmentId,
      filename: payload.filename,
      mimeType: payload.mimeType || 'application/octet-stream',
      size: payload.body.size || 0,
    });
  }

  if (payload.parts) {
    for (const part of payload.parts) {
      attachments.push(...extractAttachments(part));
    }
  }

  return attachments;
}

/**
 * Parse a Gmail API message into an EmailSummary.
 */
function toEmailSummary(msg: gmail_v1.Schema$Message): EmailSummary {
  const headers = msg.payload?.headers || [];
  return {
    id: msg.id || '',
    threadId: msg.threadId || '',
    from: extractHeader(headers, 'From'),
    to: extractHeader(headers, 'To'),
    subject: extractHeader(headers, 'Subject'),
    date: extractHeader(headers, 'Date'),
    snippet: msg.snippet || '',
    labels: msg.labelIds || [],
    isUnread: (msg.labelIds || []).includes('UNREAD'),
  };
}

/**
 * Parse a Gmail API message into an EmailFull.
 */
function toEmailFull(msg: gmail_v1.Schema$Message): EmailFull {
  const headers = msg.payload?.headers || [];
  const { html, text } = msg.payload ? extractBody(msg.payload) : { html: '', text: '' };
  const attachments = msg.payload ? extractAttachments(msg.payload) : [];

  return {
    id: msg.id || '',
    threadId: msg.threadId || '',
    from: extractHeader(headers, 'From'),
    to: extractHeader(headers, 'To'),
    cc: extractHeader(headers, 'Cc'),
    bcc: extractHeader(headers, 'Bcc'),
    subject: extractHeader(headers, 'Subject'),
    date: extractHeader(headers, 'Date'),
    body_text: text,
    body_html: html,
    labels: msg.labelIds || [],
    attachments,
    list_unsubscribe: extractHeader(headers, 'List-Unsubscribe'),
    list_unsubscribe_post: extractHeader(headers, 'List-Unsubscribe-Post'),
  };
}

/**
 * Parse a Gmail API message into a ThreadMessage (lighter than EmailFull).
 */
function toThreadMessage(msg: gmail_v1.Schema$Message): ThreadMessage {
  const headers = msg.payload?.headers || [];
  const { html, text } = msg.payload
    ? extractBody(msg.payload)
    : { html: '', text: '' };

  return {
    id: msg.id || '',
    from: extractHeader(headers, 'From'),
    to: extractHeader(headers, 'To'),
    cc: extractHeader(headers, 'Cc'),
    subject: extractHeader(headers, 'Subject'),
    date: extractHeader(headers, 'Date'),
    // An HTML-only message used to come back with an empty body while the
    // description promised "body". Fall back to the flattened HTML.
    body_text: text || (html ? htmlToText(html) : ''),
    snippet: msg.snippet || '',
    labels: msg.labelIds || [],
    attachments: msg.payload ? extractAttachments(msg.payload) : [],
  };
}

// ---------------------------------------------------------------------------
// MIME construction
// ---------------------------------------------------------------------------

/**
 * Build a message and encode it as base64url for the Gmail API.
 *
 * The assembly itself lives in mime.ts; this wrapper is the sync entry point
 * kept for callers (and tests) that only need the encoded string.
 */
export function buildRawMessage(opts: MimeOptions): string {
  return buildMimeMessage(opts).rawBase64Url;
}

/** Gmail's own wrapper around a signature block. */
function signatureSuffixes(signatureHtml: string): { html: string; text: string } {
  if (!signatureHtml || signatureHtml.trim().length === 0) {
    return { html: '', text: '' };
  }
  return {
    html:
      '<br><div class="gmail_signature" dir="ltr" data-smartmail="gmail_signature">'
      + signatureHtml
      + '</div>',
    // Gmail does not prepend the "-- " sigdashes, so neither do we.
    text: `\n\n${htmlToText(signatureHtml)}`,
  };
}

interface OutboundOptions {
  resolved: AccountConfig;
  gmail: gmail_v1.Gmail;
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
  is_html?: boolean;
  in_reply_to?: string;
  references?: string;
  /** Default true. */
  include_signature?: boolean;
  /** Absolute paths, loaded from disk. */
  attachment_paths?: string[];
  /** Already-loaded attachments (forwarded originals). */
  attachments?: Attachment[];
  /** Quoted history or forwarded-message block, appended after the signature. */
  block?: { html: string; text: string };
}

/**
 * The single composition path for every outbound tool.
 *
 * One builder, one dispatch helper: send, draft, reply, draft-reply and
 * forward all funnel through here so per-tool body construction cannot drift
 * apart again.
 *
 * Order inside the message is Gmail's default: body, then signature, then the
 * quote/forward block.
 */
async function composeOutbound(opts: OutboundOptions): Promise<BuiltMessage> {
  const profile = await getSendAsProfile(opts.resolved, opts.gmail);

  const signature = opts.include_signature === false
    ? { html: '', text: '' }
    : signatureSuffixes(profile.signatureHtml);

  const attachments: Attachment[] = [...(opts.attachments ?? [])];
  for (const filePath of opts.attachment_paths ?? []) {
    attachments.push(await loadAttachment(filePath));
  }

  return buildMimeMessage({
    from: formatFromHeader(profile.displayName, opts.resolved.email),
    to: opts.to,
    cc: opts.cc,
    bcc: opts.bcc,
    subject: opts.subject,
    body: opts.body,
    is_html: opts.is_html,
    in_reply_to: opts.in_reply_to,
    references: opts.references,
    reply_to: profile.replyTo || undefined,
    html_suffix: signature.html + (opts.block?.html ?? ''),
    text_suffix: signature.text + (opts.block?.text ?? ''),
    attachments: attachments.length > 0 ? attachments : undefined,
  });
}

/**
 * Send an assembled message, picking the transport by size.
 *
 * Up to 5MB the message rides in `requestBody.raw` as base64url. Beyond that
 * Gmail requires the media-upload path, where the RAW MIME (not base64url)
 * goes in `media.body` and `requestBody` carries only the threadId. The stream
 * is constructed inside the retry closure so a retried attempt does not
 * re-read an already-consumed stream.
 */
async function dispatchSend(
  gmail: gmail_v1.Gmail,
  built: BuiltMessage,
  threadId?: string,
): Promise<gmail_v1.Schema$Message> {
  if (built.bytes <= MEDIA_UPLOAD_THRESHOLD_BYTES) {
    const response = await withRetry(() =>
      gmail.users.messages.send({
        userId: 'me',
        requestBody: { raw: built.rawBase64Url, ...(threadId ? { threadId } : {}) },
      })
    );
    return response.data;
  }

  const rawBuffer = Buffer.from(built.raw, 'utf8');
  const response = await withRetry(() =>
    gmail.users.messages.send({
      userId: 'me',
      requestBody: threadId ? { threadId } : {},
      media: { mimeType: 'message/rfc822', body: Readable.from(rawBuffer) },
    })
  );
  return response.data;
}

/**
 * Draft counterpart of dispatchSend, with the same size-based transport rule.
 *
 * With `draftId` it REPLACES that draft (drafts.update) instead of creating a
 * new one, so update_draft goes through exactly the same transport choice as
 * draft_email rather than growing a second one.
 */
async function dispatchDraft(
  gmail: gmail_v1.Gmail,
  built: BuiltMessage,
  threadId?: string,
  draftId?: string,
): Promise<gmail_v1.Schema$Draft> {
  const thread = threadId ? { threadId } : {};

  if (built.bytes <= MEDIA_UPLOAD_THRESHOLD_BYTES) {
    const message = { raw: built.rawBase64Url, ...thread };
    const response = await withRetry(() =>
      draftId
        ? gmail.users.drafts.update({
            userId: 'me',
            id: draftId,
            requestBody: { id: draftId, message },
          })
        : gmail.users.drafts.create({ userId: 'me', requestBody: { message } })
    );
    return response.data;
  }

  const rawBuffer = Buffer.from(built.raw, 'utf8');
  // The stream is built INSIDE the retry closure: a retried attempt must not
  // re-read an already-consumed stream.
  const response = await withRetry(() => {
    const media = { mimeType: 'message/rfc822', body: Readable.from(rawBuffer) };
    return draftId
      ? gmail.users.drafts.update({
          userId: 'me',
          id: draftId,
          requestBody: { id: draftId, message: thread },
          media,
        })
      : gmail.users.drafts.create({
          userId: 'me',
          requestBody: { message: thread },
          media,
        });
  });
  return response.data;
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

const FETCH_CONCURRENCY = 10;

/**
 * Fetch metadata for many messages in parallel chunks, preserving input order.
 */
async function fetchMessageSummaries(
  gmail: gmail_v1.Gmail,
  messageRefs: Array<{ id: string }>,
): Promise<EmailSummary[]> {
  const results: EmailSummary[] = new Array(messageRefs.length);
  for (let i = 0; i < messageRefs.length; i += FETCH_CONCURRENCY) {
    const chunk = messageRefs.slice(i, i + FETCH_CONCURRENCY);
    const chunkResults = await Promise.all(
      chunk.map(msg =>
        withRetry(() =>
          gmail.users.messages.get({
            userId: 'me',
            id: msg.id,
            format: 'metadata',
            metadataHeaders: ['From', 'To', 'Subject', 'Date'],
          })
        )
      )
    );
    chunkResults.forEach((full, idx) => {
      results[i + idx] = toEmailSummary(full.data);
    });
  }
  return results;
}

/**
 * Default page size for the two message-list tools.
 *
 * It used to be 500, which meant an unparameterized `list_emails` issued ~501
 * API round trips (one messages.list plus one messages.get PER message) and
 * dumped 500 objects into the model's context. 50 is a page a model can
 * actually read; `page_token` is there for the rest.
 */
export const DEFAULT_LIST_PAGE_SIZE = 50;

/** Hard ceiling on one call, whatever the caller asks for. */
export const MAX_LIST_PAGE_SIZE = 500;

/**
 * The shared pagination + hydration path behind listMessages and
 * searchMessages.
 *
 * These were two copy-pasted loops that had already drifted apart (only one of
 * them applied labelIds), which is exactly how the label/query interaction
 * became invisible. One loop, two callers.
 */
async function collectMessagePage(
  gmail: gmail_v1.Gmail,
  params: { labelIds?: string[]; query?: string },
  maxResults: number,
  pageToken?: string,
): Promise<MessagePage> {
  const wanted = Math.min(Math.max(maxResults, 1), MAX_LIST_PAGE_SIZE);

  const refs: Array<{ id: string }> = [];
  let cursor: string | undefined = pageToken;

  while (refs.length < wanted) {
    const pageSize: number = wanted - refs.length;
    const response: { data: gmail_v1.Schema$ListMessagesResponse } = await withRetry(() =>
      gmail.users.messages.list({
        userId: 'me',
        ...(params.labelIds ? { labelIds: params.labelIds } : {}),
        maxResults: pageSize,
        q: params.query || undefined,
        pageToken: cursor,
      })
    );

    const messages = response.data.messages || [];
    for (const msg of messages) {
      if (msg.id) refs.push({ id: msg.id });
    }

    cursor = response.data.nextPageToken ?? undefined;
    if (!cursor || messages.length === 0) break;
  }

  return {
    messages: refs.length === 0 ? [] : await fetchMessageSummaries(gmail, refs),
    ...(cursor ? { nextPageToken: cursor } : {}),
  };
}

/**
 * List messages in a mailbox (INBOX by default, or one label).
 *
 * `label` and `query` are ANDed, not alternatives — a query is confined to the
 * chosen label. That is Gmail's behaviour for labelIds + q, and the tool
 * description now says so.
 */
export async function listMessages(opts: {
  account?: string;
  label?: string;
  maxResults?: number;
  query?: string;
  pageToken?: string;
}): Promise<MessagePage> {
  const gmail = await getGmailClient(opts.account);
  return collectMessagePage(
    gmail,
    { labelIds: [opts.label || 'INBOX'], query: opts.query },
    opts.maxResults ?? DEFAULT_LIST_PAGE_SIZE,
    opts.pageToken,
  );
}

/**
 * Build the headers-only result for a 'metadata' or 'minimal' fetch.
 *
 * Gmail's metadata/minimal formats never return a body. Running them through
 * `toEmailFull` produced a structurally valid, silently EMPTY email — the model
 * could not tell "this message has no text" from "you asked for a format that
 * excludes text". The `body_note` makes the difference explicit.
 */
function toEmailHeadersOnly(
  msg: gmail_v1.Schema$Message,
  format: 'metadata' | 'minimal',
): EmailHeadersOnly {
  const headers = msg.payload?.headers || [];
  return {
    id: msg.id || '',
    threadId: msg.threadId || '',
    from: extractHeader(headers, 'From'),
    to: extractHeader(headers, 'To'),
    cc: extractHeader(headers, 'Cc'),
    bcc: extractHeader(headers, 'Bcc'),
    subject: extractHeader(headers, 'Subject'),
    date: extractHeader(headers, 'Date'),
    labels: msg.labelIds || [],
    snippet: msg.snippet || '',
    body_note:
      format === 'minimal'
        ? 'No body and no headers were requested: format "minimal" returns only ids, '
          + 'labels and the snippet. Call read_email again with format "full" for the body.'
        : 'No body was requested: format "metadata" returns headers only. '
          + 'Call read_email again with format "full" for the body.',
  };
}

/**
 * Get a single message by ID.
 *
 * With the default 'full' format this returns an EmailFull. With 'metadata' or
 * 'minimal' it returns a headers-only shape carrying an explicit body_note —
 * never a full-shaped result whose body silently came back empty.
 */
export async function getMessage(opts: {
  messageId: string;
  account?: string;
  format?: 'full';
}): Promise<EmailFull>;
export async function getMessage(opts: {
  messageId: string;
  account?: string;
  format?: 'full' | 'metadata' | 'minimal';
}): Promise<EmailFull | EmailHeadersOnly>;
export async function getMessage(opts: {
  messageId: string;
  account?: string;
  format?: 'full' | 'metadata' | 'minimal';
}): Promise<EmailFull | EmailHeadersOnly> {
  const gmail = await getGmailClient(opts.account);
  const format = opts.format ?? 'full';

  const response = await withRetry(() =>
    gmail.users.messages.get({
      userId: 'me',
      id: opts.messageId,
      format,
    })
  );

  return format === 'full'
    ? toEmailFull(response.data)
    : toEmailHeadersOnly(response.data, format);
}

/**
 * Search messages using Gmail query syntax, across every label.
 */
export async function searchMessages(opts: {
  query: string;
  account?: string;
  maxResults?: number;
  pageToken?: string;
}): Promise<MessagePage> {
  const gmail = await getGmailClient(opts.account);
  return collectMessagePage(
    gmail,
    { query: opts.query },
    opts.maxResults ?? DEFAULT_LIST_PAGE_SIZE,
    opts.pageToken,
  );
}

/**
 * Send an email.
 */
export async function sendMessage(opts: {
  to: string;
  subject: string;
  body: string;
  account?: string;
  cc?: string;
  bcc?: string;
  is_html?: boolean;
  include_signature?: boolean;
  attachments?: string[];
}): Promise<SendResult> {
  const resolved = resolveAccount(opts.account);
  const gmail = await getGmailClient(resolved);

  const built = await composeOutbound({
    resolved,
    gmail,
    to: opts.to,
    subject: opts.subject,
    body: opts.body,
    cc: opts.cc,
    bcc: opts.bcc,
    is_html: opts.is_html,
    include_signature: opts.include_signature,
    attachment_paths: opts.attachments,
  });

  const sent = await dispatchSend(gmail, built);

  return {
    id: sent.id || '',
    threadId: sent.threadId || '',
    labelIds: sent.labelIds || [],
  };
}

/**
 * Create a draft email.
 */
export async function createDraft(opts: {
  to: string;
  subject: string;
  body: string;
  account?: string;
  cc?: string;
  bcc?: string;
  is_html?: boolean;
  include_signature?: boolean;
  attachments?: string[];
}): Promise<DraftResult> {
  const resolved = resolveAccount(opts.account);
  const gmail = await getGmailClient(resolved);

  const built = await composeOutbound({
    resolved,
    gmail,
    to: opts.to,
    subject: opts.subject,
    body: opts.body,
    cc: opts.cc,
    bcc: opts.bcc,
    is_html: opts.is_html,
    include_signature: opts.include_signature,
    attachment_paths: opts.attachments,
  });

  const draft = await dispatchDraft(gmail, built);

  return {
    draft_id: draft.id || '',
    message: {
      id: draft.message?.id || '',
      threadId: draft.message?.threadId || '',
    },
  };
}

/**
 * Modify labels on a message (add/remove).
 */
export async function modifyMessage(opts: {
  messageId: string;
  addLabelIds?: string[];
  removeLabelIds?: string[];
  account?: string;
}): Promise<ModifyResult> {
  const gmail = await getGmailClient(opts.account);

  const response = await withRetry(() =>
    gmail.users.messages.modify({
      userId: 'me',
      id: opts.messageId,
      requestBody: {
        addLabelIds: opts.addLabelIds || [],
        removeLabelIds: opts.removeLabelIds || [],
      },
    })
  );

  return {
    success: true,
    id: response.data.id || '',
    labels: response.data.labelIds || [],
  };
}

/**
 * Move a message to trash.
 */
export async function trashMessage(opts: {
  messageId: string;
  account?: string;
}): Promise<ModifyResult> {
  const gmail = await getGmailClient(opts.account);

  const response = await withRetry(() =>
    gmail.users.messages.trash({
      userId: 'me',
      id: opts.messageId,
    })
  );

  return {
    success: true,
    id: response.data.id || '',
  };
}

/**
 * Batch modify messages (add/remove labels).
 */
export async function batchModify(opts: {
  messageIds: string[];
  addLabelIds?: string[];
  removeLabelIds?: string[];
  account?: string;
}): Promise<BatchResult> {
  const gmail = await getGmailClient(opts.account);

  await withRetry(() =>
    gmail.users.messages.batchModify({
      userId: 'me',
      requestBody: {
        ids: opts.messageIds,
        addLabelIds: opts.addLabelIds || [],
        removeLabelIds: opts.removeLabelIds || [],
      },
    })
  );

  return {
    success: true,
    modified_count: opts.messageIds.length,
    message_ids: opts.messageIds,
  };
}

/**
 * List all labels for an account.
 */
export async function listLabels(opts?: {
  account?: string;
}): Promise<LabelInfo[]> {
  const gmail = await getGmailClient(opts?.account);

  const response = await withRetry(() =>
    gmail.users.labels.list({ userId: 'me' })
  );

  const labels = response.data.labels || [];

  return labels.map(label => ({
    id: label.id || '',
    name: label.name || '',
    type: label.type || '',
    messagesTotal: label.messagesTotal || 0,
    messagesUnread: label.messagesUnread || 0,
  }));
}

/**
 * Create a new Gmail label.
 */
export async function createLabel(opts: {
  name: string;
  account?: string;
  textColor?: string;
  backgroundColor?: string;
}): Promise<LabelInfo> {
  const gmail = await getGmailClient(opts.account);

  const color = (opts.textColor || opts.backgroundColor)
    ? {
        textColor: opts.textColor || '#000000',
        backgroundColor: opts.backgroundColor || '#ffffff',
      }
    : undefined;

  const response = await withRetry(() =>
    gmail.users.labels.create({
      userId: 'me',
      requestBody: {
        name: opts.name,
        labelListVisibility: 'labelShow',
        messageListVisibility: 'show',
        ...(color ? { color } : {}),
      },
    })
  );

  const label = response.data;
  return {
    id: label.id || '',
    name: label.name || opts.name,
    type: label.type || 'user',
    messagesTotal: label.messagesTotal || 0,
    messagesUnread: label.messagesUnread || 0,
  };
}

/**
 * Update an existing label (rename and/or recolor).
 */
export async function updateLabel(opts: {
  labelId: string;
  account?: string;
  name?: string;
  textColor?: string;
  backgroundColor?: string;
}): Promise<LabelInfo> {
  const gmail = await getGmailClient(opts.account);

  const color = (opts.textColor || opts.backgroundColor)
    ? {
        textColor: opts.textColor || '#000000',
        backgroundColor: opts.backgroundColor || '#ffffff',
      }
    : undefined;

  const response = await withRetry(() =>
    gmail.users.labels.patch({
      userId: 'me',
      id: opts.labelId,
      requestBody: {
        ...(opts.name ? { name: opts.name } : {}),
        ...(color ? { color } : {}),
      },
    })
  );

  const label = response.data;
  return {
    id: label.id || opts.labelId,
    name: label.name || '',
    type: label.type || 'user',
    messagesTotal: label.messagesTotal || 0,
    messagesUnread: label.messagesUnread || 0,
  };
}

/**
 * Delete a label. The label is removed from every message it was applied to.
 */
export async function deleteLabel(opts: {
  labelId: string;
  account?: string;
}): Promise<{ success: boolean; labelId: string }> {
  const gmail = await getGmailClient(opts.account);

  await withRetry(() =>
    gmail.users.labels.delete({
      userId: 'me',
      id: opts.labelId,
    })
  );

  return { success: true, labelId: opts.labelId };
}

/**
 * Get a thread with all its messages.
 */
export async function getThread(opts: {
  threadId: string;
  account?: string;
}): Promise<ThreadInfo> {
  const gmail = await getGmailClient(opts.account);

  const response = await withRetry(() =>
    gmail.users.threads.get({
      userId: 'me',
      id: opts.threadId,
      format: 'full',
    })
  );

  const messages = (response.data.messages || []).map(toThreadMessage);

  return {
    id: response.data.id || '',
    messages,
  };
}

/**
 * Add and/or remove labels on every message in a thread.
 *
 * The thread-level counterpart of `modifyMessage`. Archiving one message of a
 * conversation leaves the rest in the inbox, which is not what a model trained
 * on Gmail's thread-first UI expects; this operates on the whole conversation.
 */
export async function modifyThread(opts: {
  threadId: string;
  addLabelIds?: string[];
  removeLabelIds?: string[];
  account?: string;
}): Promise<ModifyResult> {
  const add = opts.addLabelIds ?? [];
  const remove = opts.removeLabelIds ?? [];
  if (add.length === 0 && remove.length === 0) {
    throw new Error(
      'modify_thread needs at least one of add_labels or remove_labels; '
      + 'with neither it would be a no-op reported as a success.'
    );
  }

  const resolved = resolveAccount(opts.account);
  const gmail = await getGmailClient(resolved);

  log('info', 'modify_thread', {
    account: resolved.alias,
    thread_id: opts.threadId,
    add: add.length,
    remove: remove.length,
  });

  const response = await withRetry(() =>
    gmail.users.threads.modify({
      userId: 'me',
      id: opts.threadId,
      requestBody: { addLabelIds: add, removeLabelIds: remove },
    })
  );

  // threads.modify returns the thread, whose messages carry the new labels.
  const labels = new Set<string>();
  for (const msg of response.data.messages || []) {
    for (const id of msg.labelIds || []) labels.add(id);
  }

  return {
    success: true,
    id: response.data.id || opts.threadId,
    labels: [...labels],
  };
}

/**
 * Move an entire thread to Trash.
 */
export async function trashThread(opts: {
  threadId: string;
  account?: string;
}): Promise<ModifyResult> {
  const resolved = resolveAccount(opts.account);
  const gmail = await getGmailClient(resolved);

  log('info', 'trash_thread', { account: resolved.alias, thread_id: opts.threadId });

  const response = await withRetry(() =>
    gmail.users.threads.trash({ userId: 'me', id: opts.threadId })
  );

  return {
    success: true,
    id: response.data.id || opts.threadId,
  };
}

/**
 * Build a "Re:" subject if not already present.
 * Exported for unit testing.
 */
export function buildReplySubject(originalSubject: string): string {
  return /^re:/i.test(originalSubject) ? originalSubject : `Re: ${originalSubject}`;
}

/**
 * Build the References chain by appending the original Message-ID to any
 * existing References header. Exported for unit testing.
 */
export function buildReferences(originalReferences: string, originalMessageId: string): string {
  return originalReferences ? `${originalReferences} ${originalMessageId}` : originalMessageId;
}

/**
 * Build the CC list for a reply, deduplicated against self and previous-to/cc.
 * Exported for unit testing.
 */
export function buildReplyCc(opts: {
  selfEmail: string;
  originalTo: string;
  originalCc: string;
  userCc?: string;
  replyAll?: boolean;
}): string | undefined {
  const extractEmail = (addr: string): string => {
    const match = addr.match(/<([^>]+)>/);
    return (match ? match[1] : addr).trim().toLowerCase();
  };

  const ccParts: string[] = [];
  const seen = new Set<string>();
  seen.add(opts.selfEmail.toLowerCase());

  const addAll = (raw: string) => {
    for (const addr of raw.split(',').map(a => a.trim()).filter(a => a.length > 0)) {
      const email = extractEmail(addr);
      if (!seen.has(email)) {
        seen.add(email);
        ccParts.push(addr);
      }
    }
  };

  if (opts.replyAll) {
    addAll([opts.originalTo, opts.originalCc].filter(Boolean).join(', '));
  }
  if (opts.userCc) {
    addAll(opts.userCc);
  }

  return ccParts.length > 0 ? ccParts.join(', ') : undefined;
}

/**
 * Split an address list into its entries, preserving `Name <addr>` formatting.
 */
function splitAddressList(raw: string): string[] {
  return raw.split(',').map(a => a.trim()).filter(a => a.length > 0);
}

function addressOf(entry: string): string {
  const match = entry.match(/<([^>]+)>/);
  return (match ? match[1] : entry).trim().toLowerCase();
}

/**
 * Build a reply's To and Cc the way Gmail does.
 *
 * `To` is the original's Reply-To when it set one, otherwise its From — plus,
 * on reply-all, the original To recipients minus self. `Cc` is the original Cc
 * minus self, plus any caller-supplied Cc.
 *
 * Two defects are fixed here: Reply-To used to be ignored entirely, so replies
 * to ticketing systems and mailing lists went to the wrong address (R1); and
 * reply-all used to fold the original To recipients into Cc (R2).
 *
 * Exported for unit testing.
 */
export function buildReplyRecipients(opts: {
  selfEmail: string;
  originalFrom: string;
  originalReplyTo?: string;
  originalTo: string;
  originalCc: string;
  userCc?: string;
  replyAll?: boolean;
}): { to: string; cc: string | undefined } {
  const self = opts.selfEmail.trim().toLowerCase();
  const seen = new Set<string>();

  const primary = (opts.originalReplyTo && opts.originalReplyTo.trim().length > 0)
    ? opts.originalReplyTo.trim()
    : opts.originalFrom.trim();

  const toParts: string[] = [];
  // The primary recipient is always addressed, even when it is the account
  // itself (replying to your own message).
  for (const entry of splitAddressList(primary)) {
    const email = addressOf(entry);
    if (seen.has(email)) continue;
    seen.add(email);
    toParts.push(entry);
  }
  seen.add(self);

  const ccParts: string[] = [];
  const addAll = (list: string, into: string[]): void => {
    for (const entry of splitAddressList(list)) {
      const email = addressOf(entry);
      if (seen.has(email)) continue;
      seen.add(email);
      into.push(entry);
    }
  };

  if (opts.replyAll) {
    addAll(opts.originalTo, toParts);
    addAll(opts.originalCc, ccParts);
  }
  if (opts.userCc) {
    addAll(opts.userCc, ccParts);
  }

  return {
    to: toParts.join(', '),
    cc: ccParts.length > 0 ? ccParts.join(', ') : undefined,
  };
}

interface ReplyOpts {
  messageId: string;
  body: string;
  account?: string;
  is_html?: boolean;
  reply_all?: boolean;
  cc?: string;
  bcc?: string;
  include_signature?: boolean;
  include_quote?: boolean;
  attachments?: string[];
}

/**
 * Fetch the original message and build a reply with proper threading headers
 * (In-Reply-To, References, threadId), Gmail-native recipients, and the
 * quoted original below the new text.
 */
async function prepareReply(
  opts: ReplyOpts,
): Promise<{ built: BuiltMessage; threadId: string | undefined; gmail: gmail_v1.Gmail }> {
  const resolved = resolveAccount(opts.account);
  const gmail = await getGmailClient(resolved);

  // 'full' rather than 'metadata': metadata cannot return a body, and the body
  // is what the quote block is built from.
  let original: { data: gmail_v1.Schema$Message };
  try {
    original = await withRetry(() =>
      gmail.users.messages.get({ userId: 'me', id: opts.messageId, format: 'full' })
    );
  } catch (err: unknown) {
    const status = (err as { code?: number; response?: { status?: number } })?.code
      ?? (err as { response?: { status?: number } })?.response?.status;
    if (status === 404) {
      throw new Error(
        `Message ${opts.messageId} was not found in account "${resolved.alias}" `
        + `(${resolved.email}). If it lives in another account, pass that account's alias.`
      );
    }
    throw err;
  }

  const headers = original.data.payload?.headers || [];
  const originalFrom = extractHeader(headers, 'From');
  const originalReplyTo = extractHeader(headers, 'Reply-To');
  const originalTo = extractHeader(headers, 'To');
  const originalCc = extractHeader(headers, 'Cc');
  const originalSubject = extractHeader(headers, 'Subject');
  const originalMessageId = extractHeader(headers, 'Message-ID');
  const originalReferences = extractHeader(headers, 'References');
  const originalDate = extractHeader(headers, 'Date');

  const recipients = buildReplyRecipients({
    selfEmail: resolved.email,
    originalFrom,
    originalReplyTo,
    originalTo,
    originalCc,
    userCc: opts.cc,
    replyAll: opts.reply_all,
  });

  let block: { html: string; text: string } | undefined;
  if (opts.include_quote !== false) {
    const body = original.data.payload
      ? extractBody(original.data.payload)
      : { html: '', text: '' };
    block = buildQuoteBlock({
      from: originalFrom,
      date: originalDate,
      html: body.html,
      text: body.text,
    });
  }

  const built = await composeOutbound({
    resolved,
    gmail,
    to: recipients.to,
    cc: recipients.cc,
    bcc: opts.bcc,
    subject: buildReplySubject(originalSubject),
    body: opts.body,
    is_html: opts.is_html,
    in_reply_to: originalMessageId,
    references: buildReferences(originalReferences, originalMessageId),
    include_signature: opts.include_signature,
    attachment_paths: opts.attachments,
    block,
  });

  return { built, threadId: original.data.threadId || undefined, gmail };
}

/**
 * Send a reply to an existing message with proper threading headers.
 */
export async function replyToMessage(opts: ReplyOpts): Promise<SendResult> {
  const { built, threadId, gmail } = await prepareReply(opts);
  const sent = await dispatchSend(gmail, built, threadId);

  return {
    id: sent.id || '',
    threadId: sent.threadId || '',
    labelIds: sent.labelIds || [],
  };
}

/**
 * Create a draft reply with the same threading semantics as replyToMessage.
 */
export async function createDraftReply(opts: ReplyOpts): Promise<DraftResult> {
  const { built, threadId, gmail } = await prepareReply(opts);
  const draft = await dispatchDraft(gmail, built, threadId);

  return {
    draft_id: draft.id || '',
    message: {
      id: draft.message?.id || '',
      threadId: draft.message?.threadId || '',
    },
  };
}

export interface ParsedUnsubscribe {
  httpsUrls: string[];
  mailto: { address: string; subject: string; body: string } | null;
  canOneClick: boolean;
}

/**
 * Parse RFC 2369 List-Unsubscribe + RFC 8058 List-Unsubscribe-Post into actionable parts.
 * Exported for unit testing.
 */
export function parseUnsubscribeHeaders(
  listUnsub: string,
  listUnsubPost: string,
): ParsedUnsubscribe {
  if (!listUnsub) {
    return { httpsUrls: [], mailto: null, canOneClick: false };
  }

  const httpsUrls: string[] = [];
  let mailto: ParsedUnsubscribe['mailto'] = null;

  for (const match of listUnsub.matchAll(/<([^>]+)>/g)) {
    const entry = match[1].trim();
    if (/^https?:\/\//i.test(entry)) {
      httpsUrls.push(entry);
    } else if (/^mailto:/i.test(entry) && !mailto) {
      const [address, queryString] = entry.replace(/^mailto:/i, '').split('?');
      const params = new URLSearchParams(queryString || '');
      mailto = {
        address,
        subject: params.get('subject') || 'Unsubscribe',
        body: params.get('body') || 'Unsubscribe',
      };
    }
  }

  return {
    httpsUrls,
    mailto,
    canOneClick: httpsUrls.length > 0 && listUnsubPost.length > 0,
  };
}

/**
 * Unsubscribe from a mailing list by processing the List-Unsubscribe header.
 * Prefers RFC 8058 one-click HTTPS POST; falls back to mailto.
 */
export async function unsubscribeFromEmail(opts: {
  messageId: string;
  account?: string;
}): Promise<UnsubscribeResult> {
  const resolved = resolveAccount(opts.account);
  const gmail = await getGmailClient(resolved);

  const response = await withRetry(() =>
    gmail.users.messages.get({
      userId: 'me',
      id: opts.messageId,
      format: 'metadata',
      metadataHeaders: ['List-Unsubscribe', 'List-Unsubscribe-Post'],
    })
  );

  const headers = response.data.payload?.headers || [];
  const listUnsub = extractHeader(headers, 'List-Unsubscribe');
  const listUnsubPost = extractHeader(headers, 'List-Unsubscribe-Post');

  if (!listUnsub) {
    return { success: false, method: 'none', detail: 'No List-Unsubscribe header found on this email.' };
  }

  const { httpsUrls, mailto, canOneClick } = parseUnsubscribeHeaders(listUnsub, listUnsubPost);

  // Try every HTTPS URL in order when one-click is available.
  const httpsFailures: string[] = [];
  if (canOneClick) {
    for (const url of httpsUrls) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: listUnsubPost,
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok || res.status === 204) {
          return {
            success: true,
            method: 'https',
            detail: `One-click unsubscribe POST to ${url} succeeded (${res.status}).`,
          };
        }
        httpsFailures.push(`${url} → HTTP ${res.status}`);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        httpsFailures.push(`${url} → ${reason}`);
      }
    }
  }

  // Fallback: mailto unsubscribe.
  if (mailto) {
    // Legacy single-part text/plain, no signature — an unsubscribe request is
    // a machine-to-machine message, not correspondence.
    const raw = buildRawMessage({
      from: resolved.email,
      to: mailto.address,
      subject: mailto.subject,
      body: mailto.body,
      plain_text_only: true,
    });

    await withRetry(() =>
      gmail.users.messages.send({
        userId: 'me',
        requestBody: { raw },
      })
    );

    const httpsNote = httpsFailures.length > 0
      ? ` HTTPS attempt(s) failed first: ${httpsFailures.join('; ')}.`
      : '';
    return {
      success: true,
      method: 'mailto',
      detail: `Unsubscribe email sent to ${mailto.address}.${httpsNote}`,
    };
  }

  // HTTPS URL(s) present but no usable one-click path — return manual URL.
  if (httpsUrls.length > 0) {
    const reason = httpsFailures.length > 0
      ? `Auto-POST failed: ${httpsFailures.join('; ')}.`
      : 'No List-Unsubscribe-Post header for one-click.';
    return {
      success: false,
      method: 'https',
      detail: `Cannot auto-unsubscribe (${reason}) Visit manually: ${httpsUrls[0]}`,
    };
  }

  return { success: false, method: 'none', detail: `Could not parse List-Unsubscribe header: ${listUnsub}` };
}

/**
 * Build a "Fwd:" subject if not already prefixed.
 * Exported for unit testing.
 */
export function buildForwardSubject(originalSubject: string): string {
  return /^fwd?:/i.test(originalSubject) ? originalSubject : `Fwd: ${originalSubject}`;
}

/**
 * Forward an existing message to new recipients.
 *
 * The caller's optional intro is the message body proper and goes through the
 * normal composition pipeline; the forwarded-message block is appended after
 * the signature, in both flavours. The original's attachments are re-attached
 * unless `include_attachments` is false.
 *
 * A forward starts a new thread (no In-Reply-To / References / threadId) —
 * that is what Gmail does, and it is deliberate.
 */
export async function forwardMessage(opts: {
  messageId: string;
  to: string;
  account?: string;
  body?: string;
  cc?: string;
  bcc?: string;
  is_html?: boolean;
  include_signature?: boolean;
  include_attachments?: boolean;
}): Promise<SendResult> {
  const resolved = resolveAccount(opts.account);
  const gmail = await getGmailClient(resolved);

  const original = await getMessage({
    messageId: opts.messageId,
    account: resolved.email,
    format: 'full',
  });

  const attachments: Attachment[] = [];
  if (opts.include_attachments !== false) {
    for (const info of original.attachments) {
      // The low-level fetch, not getAttachment: a forward re-attaches the
      // original's files whatever their size, so the 1MB inline gate that
      // protects the model's context must not apply here.
      const content = await fetchAttachmentBytes({
        messageId: opts.messageId,
        attachmentId: info.attachmentId,
        account: resolved,
      });
      attachments.push({
        filename: sanitizeFilename(info.filename),
        mimeType: info.mimeType,
        content,
      });
    }
  }

  const block = buildForwardBlock({
    originalFrom: original.from,
    originalDate: original.date,
    originalSubject: original.subject,
    originalTo: original.to,
    originalCc: original.cc || undefined,
    originalHtml: original.body_html,
    originalText: original.body_text,
  });

  const built = await composeOutbound({
    resolved,
    gmail,
    to: opts.to,
    cc: opts.cc,
    bcc: opts.bcc,
    subject: buildForwardSubject(original.subject),
    body: opts.body ?? '',
    is_html: opts.is_html,
    include_signature: opts.include_signature,
    attachments,
    block,
  });

  const sent = await dispatchSend(gmail, built);

  return {
    id: sent.id || '',
    threadId: sent.threadId || '',
    labelIds: sent.labelIds || [],
  };
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

/**
 * Above this decoded size an attachment is never inlined as base64 — the caller
 * must supply `save_dir` instead. A 25MB attachment inlines to ~34MB of base64
 * inside a JSON string, which is a context-window bomb, not a result.
 */
export const ATTACHMENT_INLINE_LIMIT_BYTES = 1_000_000;

/**
 * Reduce a message part's filename to something safe to join onto a directory.
 *
 * The filename comes from the message, i.e. from whoever sent it, so it is
 * hostile input: `../../.ssh/authorized_keys` must not escape `save_dir`.
 * Exported for unit testing.
 */
export function safeAttachmentFilename(filename: string): string {
  const flattened = (filename || '').replace(/[\r\n"\0]/g, '').replace(/\\/g, '/');
  const base = path.basename(flattened).replace(/^\.+$/, '').trim();
  if (base.length === 0) return 'attachment';
  return base.slice(0, 200);
}

/**
 * Locate an attachment's part metadata (filename, mimeType, decoded size)
 * inside its message. Gmail's `attachments.get` returns neither the filename
 * nor the MIME type, so the part table is the only place to get them.
 */
async function findAttachmentInfo(
  gmail: gmail_v1.Gmail,
  messageId: string,
  attachmentId: string,
): Promise<AttachmentInfo | undefined> {
  const response = await withRetry(() =>
    gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' })
  );
  const payload = response.data.payload;
  if (!payload) return undefined;
  return extractAttachments(payload).find(a => a.attachmentId === attachmentId);
}

/**
 * Download an attachment's bytes.
 *
 * The low-level half of `getAttachment`, split out so internal callers (the
 * forward path re-attaching the original's files) get the bytes without going
 * through the size gate or the base64 round trip.
 */
export async function fetchAttachmentBytes(opts: {
  messageId: string;
  attachmentId: string;
  account?: string | AccountConfig;
}): Promise<Buffer> {
  const gmail = await getGmailClient(opts.account);

  const response = await withRetry(() =>
    gmail.users.messages.attachments.get({
      userId: 'me',
      messageId: opts.messageId,
      id: opts.attachmentId,
    })
  );

  // Gmail returns base64url. Node decodes that directly, which also disposes of
  // the missing-'=' padding problem the old string-surgery version had.
  return Buffer.from(response.data.data || '', 'base64url');
}

/**
 * Write attachment bytes into `saveDir`, never overwriting an existing file.
 *
 * Collisions get a `-1`, `-2`, … suffix before the extension. The write uses
 * the `wx` flag so the existence check and the create are one atomic operation
 * rather than a check-then-write race.
 */
async function writeAttachmentToDir(
  saveDir: string,
  filename: string,
  content: Buffer,
): Promise<string> {
  if (!path.isAbsolute(saveDir)) {
    throw new Error(`save_dir must be an absolute path (got "${saveDir}").`);
  }

  let stat;
  try {
    stat = await fsp.stat(saveDir);
  } catch {
    throw new Error(`save_dir does not exist: ${saveDir}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`save_dir is not a directory: ${saveDir}`);
  }

  const safe = safeAttachmentFilename(filename);
  const ext = path.extname(safe);
  const stem = safe.slice(0, safe.length - ext.length) || 'attachment';

  for (let n = 0; n < 1000; n++) {
    const candidate = path.join(saveDir, n === 0 ? safe : `${stem}-${n}${ext}`);
    try {
      await fsp.writeFile(candidate, content, { flag: 'wx' });
      return candidate;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') continue;
      throw err;
    }
  }

  throw new Error(`Could not find a free filename for "${safe}" in ${saveDir}.`);
}

/**
 * Fetch an attachment, either writing it to disk or returning it inline.
 *
 * With `saveDir`: the bytes go to a file and the result carries its path.
 * Without: the bytes come back as standard padded base64, but only when the
 * attachment is at or below ATTACHMENT_INLINE_LIMIT_BYTES — a larger one gets a
 * clear error naming `save_dir` rather than a 34MB string.
 *
 * Filename and MIME type are always returned; both come from the message part,
 * not from the attachments endpoint (which reports neither).
 */
export async function getAttachment(opts: {
  messageId: string;
  attachmentId: string;
  account?: string;
  saveDir?: string;
}): Promise<AttachmentData> {
  const gmail = await getGmailClient(opts.account);

  const info = await findAttachmentInfo(gmail, opts.messageId, opts.attachmentId);
  const filename = safeAttachmentFilename(info?.filename ?? 'attachment');
  const mimeType = info?.mimeType ?? 'application/octet-stream';

  // Refuse an oversized inline request BEFORE downloading it: the part table
  // already knows the decoded size.
  if (!opts.saveDir && info && info.size > ATTACHMENT_INLINE_LIMIT_BYTES) {
    throw new Error(
      `Attachment "${filename}" is ${(info.size / 1_000_000).toFixed(1)}MB, over the `
      + `${ATTACHMENT_INLINE_LIMIT_BYTES / 1_000_000}MB inline limit. `
      + `Call get_attachment again with save_dir set to an absolute directory path `
      + `to write it to disk instead.`
    );
  }

  const content = await fetchAttachmentBytes({
    messageId: opts.messageId,
    attachmentId: opts.attachmentId,
    account: opts.account,
  });

  if (opts.saveDir) {
    const written = await writeAttachmentToDir(opts.saveDir, filename, content);
    return {
      attachmentId: opts.attachmentId,
      filename: path.basename(written),
      mimeType,
      size: content.length,
      path: written,
    };
  }

  // Belt and braces: the part table may be missing (a draft mid-edit, an
  // unusual structure), in which case the size is only known once downloaded.
  if (content.length > ATTACHMENT_INLINE_LIMIT_BYTES) {
    throw new Error(
      `Attachment "${filename}" is ${(content.length / 1_000_000).toFixed(1)}MB, over the `
      + `${ATTACHMENT_INLINE_LIMIT_BYTES / 1_000_000}MB inline limit. `
      + `Call get_attachment again with save_dir set to an absolute directory path `
      + `to write it to disk instead.`
    );
  }

  return {
    attachmentId: opts.attachmentId,
    filename,
    mimeType,
    size: content.length,
    data_base64: content.toString('base64'),
  };
}

/**
 * List drafts in the user's mailbox. Returns summaries with id + headers.
 */
export async function listDrafts(opts: {
  account?: string;
  maxResults?: number;
  pageToken?: string;
}): Promise<DraftPage> {
  const gmail = await getGmailClient(opts.account);
  const wanted = Math.min(Math.max(opts.maxResults ?? 100, 1), MAX_LIST_PAGE_SIZE);

  // This was a single un-paginated drafts.list — the one list tool that broke
  // the convention, so drafts past the first page were unreachable.
  const refs: gmail_v1.Schema$Draft[] = [];
  let cursor: string | undefined = opts.pageToken;

  while (refs.length < wanted) {
    const response: { data: gmail_v1.Schema$ListDraftsResponse } = await withRetry(() =>
      gmail.users.drafts.list({
        userId: 'me',
        maxResults: wanted - refs.length,
        pageToken: cursor,
      })
    );

    const page = response.data.drafts || [];
    refs.push(...page.filter(d => d.id && d.message?.id));

    cursor = response.data.nextPageToken ?? undefined;
    if (!cursor || page.length === 0) break;
  }

  const nextPageToken = cursor ? { nextPageToken: cursor } : {};

  const drafts = refs;
  if (drafts.length === 0) return { drafts: [], ...nextPageToken };

  // Fetch each draft's underlying message metadata in parallel.
  const results: DraftSummary[] = new Array(drafts.length);
  for (let i = 0; i < drafts.length; i += FETCH_CONCURRENCY) {
    const chunk = drafts.slice(i, i + FETCH_CONCURRENCY);
    const chunkResults = await Promise.all(
      chunk.map(d =>
        withRetry(() =>
          gmail.users.messages.get({
            userId: 'me',
            id: d.message!.id!,
            format: 'metadata',
            metadataHeaders: ['From', 'To', 'Subject', 'Date'],
          })
        )
      )
    );
    chunkResults.forEach((msg, idx) => {
      const headers = msg.data.payload?.headers || [];
      results[i + idx] = {
        draft_id: drafts[i + idx].id!,
        message_id: msg.data.id || '',
        threadId: msg.data.threadId || '',
        from: extractHeader(headers, 'From'),
        to: extractHeader(headers, 'To'),
        subject: extractHeader(headers, 'Subject'),
        date: extractHeader(headers, 'Date'),
        snippet: msg.data.snippet || '',
      };
    });
  }

  return { drafts: results, ...nextPageToken };
}

/**
 * Read a single draft by its draft ID. Returns the full underlying message.
 */
export async function readDraft(opts: {
  draftId: string;
  account?: string;
}): Promise<DraftFull> {
  const gmail = await getGmailClient(opts.account);

  const response = await withRetry(() =>
    gmail.users.drafts.get({
      userId: 'me',
      id: opts.draftId,
      format: 'full',
    })
  );

  const msg = response.data.message;
  if (!msg) {
    throw new Error(`Draft ${opts.draftId} has no underlying message.`);
  }

  return {
    draft_id: response.data.id || '',
    message: toEmailFull(msg),
  };
}

/**
 * Replace a draft's contents.
 *
 * The message is rebuilt through the same `composeOutbound` path as
 * `createDraft` — signature, multipart/alternative, attachments and header
 * sanitation all included — so an updated draft is byte-for-byte the same kind
 * of message a freshly created one would be. `drafts.update` REPLACES the
 * draft, so every field has to be supplied again; that is Gmail's semantics,
 * not a shortcut, and the tool description says so.
 */
export async function updateDraft(opts: {
  draftId: string;
  to: string;
  subject: string;
  body: string;
  account?: string;
  cc?: string;
  bcc?: string;
  is_html?: boolean;
  include_signature?: boolean;
  attachments?: string[];
}): Promise<DraftResult> {
  const resolved = resolveAccount(opts.account);
  const gmail = await getGmailClient(resolved);

  const built = await composeOutbound({
    resolved,
    gmail,
    to: opts.to,
    subject: opts.subject,
    body: opts.body,
    cc: opts.cc,
    bcc: opts.bcc,
    is_html: opts.is_html,
    include_signature: opts.include_signature,
    attachment_paths: opts.attachments,
  });

  // The existing draft's threadId must be preserved or Gmail detaches a reply
  // draft from its conversation.
  let threadId: string | undefined;
  try {
    const existing = await withRetry(() =>
      gmail.users.drafts.get({ userId: 'me', id: opts.draftId, format: 'minimal' })
    );
    threadId = existing.data.message?.threadId || undefined;
  } catch (err: unknown) {
    const status = (err as { code?: number; response?: { status?: number } })?.code
      ?? (err as { response?: { status?: number } })?.response?.status;
    if (status === 404) {
      throw new Error(
        `Draft ${opts.draftId} was not found in account "${resolved.alias}" `
        + `(${resolved.email}). If it lives in another account, pass that account's alias.`
      );
    }
    throw err;
  }

  const draft = await dispatchDraft(gmail, built, threadId, opts.draftId);

  return {
    draft_id: draft.id || opts.draftId,
    message: {
      id: draft.message?.id || '',
      threadId: draft.message?.threadId || '',
    },
  };
}

/**
 * Permanently delete a draft. The draft is gone — this is not a trash.
 */
export async function deleteDraft(opts: {
  draftId: string;
  account?: string;
}): Promise<{ success: boolean; draft_id: string }> {
  const resolved = resolveAccount(opts.account);
  const gmail = await getGmailClient(resolved);

  log('info', 'delete_draft', { account: resolved.alias, draft_id: opts.draftId });

  await withRetry(() =>
    gmail.users.drafts.delete({ userId: 'me', id: opts.draftId })
  );

  return { success: true, draft_id: opts.draftId };
}

/**
 * Send an existing draft by its draft ID.
 */
export async function sendDraft(opts: {
  draftId: string;
  account?: string;
}): Promise<SendResult> {
  const gmail = await getGmailClient(opts.account);

  const response = await withRetry(() =>
    gmail.users.drafts.send({
      userId: 'me',
      requestBody: {
        id: opts.draftId,
      },
    })
  );

  return {
    id: response.data.id || '',
    threadId: response.data.threadId || '',
    labelIds: response.data.labelIds || [],
  };
}
