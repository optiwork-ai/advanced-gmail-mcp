import { google } from 'googleapis';
import type { gmail_v1 } from 'googleapis';
import type { Auth } from 'googleapis';
import { type AccountConfig, resolveAccount } from '../config.js';
import { getAuthClient } from './auth.js';
import { log } from '../log.js';
import type {
  EmailSummary,
  EmailFull,
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
 * Recursively extract HTML and plain-text body from a MIME payload.
 */
function extractBody(payload: gmail_v1.Schema$MessagePart): { html: string; text: string } {
  let html = '';
  let text = '';

  if (payload.mimeType === 'text/html' && payload.body?.data) {
    html = decodeBase64Url(payload.body.data);
  } else if (payload.mimeType === 'text/plain' && payload.body?.data) {
    text = decodeBase64Url(payload.body.data);
  }

  if (payload.parts) {
    for (const part of payload.parts) {
      const result = extractBody(part);
      if (result.html) html = result.html;
      if (result.text) text = result.text;
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
  const { text } = msg.payload ? extractBody(msg.payload) : { text: '' };

  return {
    id: msg.id || '',
    from: extractHeader(headers, 'From'),
    to: extractHeader(headers, 'To'),
    cc: extractHeader(headers, 'Cc'),
    subject: extractHeader(headers, 'Subject'),
    date: extractHeader(headers, 'Date'),
    body_text: text,
    snippet: msg.snippet || '',
    labels: msg.labelIds || [],
  };
}

// ---------------------------------------------------------------------------
// MIME construction
// ---------------------------------------------------------------------------

interface MimeOptions {
  to: string;
  subject: string;
  body: string;
  from?: string;
  cc?: string;
  bcc?: string;
  is_html?: boolean;
  in_reply_to?: string;
  references?: string;
}

/**
 * RFC 2047 encoded-word for header values containing non-ASCII characters.
 * Returns the value untouched when it's pure ASCII. Exported for unit testing.
 */
export function encodeHeaderValue(value: string): string {
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  const encoded = Buffer.from(value, 'utf-8').toString('base64');
  return `=?UTF-8?B?${encoded}?=`;
}

/**
 * Build an RFC 2822 message and encode as base64url for the Gmail API.
 */
function buildRawMessage(opts: MimeOptions): string {
  const lines: string[] = [];

  if (opts.from) lines.push(`From: ${opts.from}`);
  lines.push(`To: ${opts.to}`);
  if (opts.cc) lines.push(`Cc: ${opts.cc}`);
  if (opts.bcc) lines.push(`Bcc: ${opts.bcc}`);
  lines.push(`Subject: ${encodeHeaderValue(opts.subject)}`);
  if (opts.in_reply_to) lines.push(`In-Reply-To: ${opts.in_reply_to}`);
  if (opts.references) lines.push(`References: ${opts.references}`);
  lines.push(`MIME-Version: 1.0`);
  lines.push(`Content-Type: ${opts.is_html ? 'text/html' : 'text/plain'}; charset="UTF-8"`);
  lines.push(''); // blank line separates headers from body
  lines.push(opts.body);

  const raw = lines.join('\r\n');
  return Buffer.from(raw).toString('base64url');
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
 * List messages in a mailbox.
 * Paginates through all results up to maxResults (default 500, hard cap 1000).
 */
export async function listMessages(opts: {
  account?: string;
  label?: string;
  maxResults?: number;
  query?: string;
}): Promise<EmailSummary[]> {
  const gmail = await getGmailClient(opts.account);
  const labelIds = opts.label ? [opts.label] : ['INBOX'];
  const maxResults = Math.min(opts.maxResults ?? 500, 1000);

  const allMessageRefs: Array<{ id: string }> = [];
  let pageToken: string | undefined;

  while (allMessageRefs.length < maxResults) {
    const pageSize = Math.min(maxResults - allMessageRefs.length, 500);
    const response = await withRetry(() =>
      gmail.users.messages.list({
        userId: 'me',
        labelIds,
        maxResults: pageSize,
        q: opts.query || undefined,
        pageToken,
      })
    );

    const messages = response.data.messages || [];
    for (const msg of messages) {
      if (msg.id) allMessageRefs.push({ id: msg.id });
    }

    pageToken = response.data.nextPageToken ?? undefined;
    if (!pageToken || messages.length === 0) break;
  }

  if (allMessageRefs.length === 0) return [];

  return fetchMessageSummaries(gmail, allMessageRefs);
}

/**
 * Get a single message by ID.
 */
export async function getMessage(opts: {
  messageId: string;
  account?: string;
  format?: 'full' | 'metadata' | 'minimal';
}): Promise<EmailFull> {
  const gmail = await getGmailClient(opts.account);
  const format = opts.format ?? 'full';

  const response = await withRetry(() =>
    gmail.users.messages.get({
      userId: 'me',
      id: opts.messageId,
      format,
    })
  );

  return toEmailFull(response.data);
}

/**
 * Search messages using Gmail query syntax.
 * Paginates through all results up to maxResults (default 500, hard cap 1000).
 */
export async function searchMessages(opts: {
  query: string;
  account?: string;
  maxResults?: number;
}): Promise<EmailSummary[]> {
  const gmail = await getGmailClient(opts.account);
  const maxResults = Math.min(opts.maxResults ?? 500, 1000);

  // Paginate through messages.list to collect all message IDs
  const allMessageRefs: Array<{ id: string }> = [];
  let pageToken: string | undefined;

  while (allMessageRefs.length < maxResults) {
    const pageSize = Math.min(maxResults - allMessageRefs.length, 500);
    const response = await withRetry(() =>
      gmail.users.messages.list({
        userId: 'me',
        q: opts.query,
        maxResults: pageSize,
        pageToken,
      })
    );

    const messages = response.data.messages || [];
    for (const msg of messages) {
      if (msg.id) allMessageRefs.push({ id: msg.id });
    }

    pageToken = response.data.nextPageToken ?? undefined;
    if (!pageToken || messages.length === 0) break;
  }

  if (allMessageRefs.length === 0) return [];

  return fetchMessageSummaries(gmail, allMessageRefs);
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
}): Promise<SendResult> {
  const resolved = resolveAccount(opts.account);
  const gmail = await getGmailClient(resolved);

  const raw = buildRawMessage({
    from: resolved.email,
    to: opts.to,
    subject: opts.subject,
    body: opts.body,
    cc: opts.cc,
    bcc: opts.bcc,
    is_html: opts.is_html,
  });

  const response = await withRetry(() =>
    gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw },
    })
  );

  return {
    id: response.data.id || '',
    threadId: response.data.threadId || '',
    labelIds: response.data.labelIds || [],
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
}): Promise<DraftResult> {
  const resolved = resolveAccount(opts.account);
  const gmail = await getGmailClient(resolved);

  const raw = buildRawMessage({
    from: resolved.email,
    to: opts.to,
    subject: opts.subject,
    body: opts.body,
    cc: opts.cc,
    bcc: opts.bcc,
    is_html: opts.is_html,
  });

  const response = await withRetry(() =>
    gmail.users.drafts.create({
      userId: 'me',
      requestBody: {
        message: { raw },
      },
    })
  );

  return {
    draft_id: response.data.id || '',
    message: {
      id: response.data.message?.id || '',
      threadId: response.data.message?.threadId || '',
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

interface ReplyOpts {
  messageId: string;
  body: string;
  account?: string;
  is_html?: boolean;
  reply_all?: boolean;
  cc?: string;
  bcc?: string;
}

/**
 * Fetch the original message and build a base64url-encoded reply with
 * proper threading headers (In-Reply-To, References, threadId).
 */
async function prepareReply(opts: ReplyOpts): Promise<{ raw: string; threadId: string | undefined }> {
  const resolved = resolveAccount(opts.account);
  const gmail = await getGmailClient(resolved);

  const original = await withRetry(() =>
    gmail.users.messages.get({
      userId: 'me',
      id: opts.messageId,
      format: 'metadata',
      metadataHeaders: ['From', 'To', 'Cc', 'Subject', 'Message-ID', 'References'],
    })
  );

  const headers = original.data.payload?.headers || [];
  const originalFrom = extractHeader(headers, 'From');
  const originalTo = extractHeader(headers, 'To');
  const originalCc = extractHeader(headers, 'Cc');
  const originalSubject = extractHeader(headers, 'Subject');
  const originalMessageId = extractHeader(headers, 'Message-ID');
  const originalReferences = extractHeader(headers, 'References');

  const raw = buildRawMessage({
    from: resolved.email,
    to: originalFrom,
    cc: buildReplyCc({
      selfEmail: resolved.email,
      originalTo,
      originalCc,
      userCc: opts.cc,
      replyAll: opts.reply_all,
    }),
    bcc: opts.bcc,
    subject: buildReplySubject(originalSubject),
    body: opts.body,
    is_html: opts.is_html,
    in_reply_to: originalMessageId,
    references: buildReferences(originalReferences, originalMessageId),
  });

  return { raw, threadId: original.data.threadId || undefined };
}

/**
 * Send a reply to an existing message with proper threading headers.
 */
export async function replyToMessage(opts: ReplyOpts): Promise<SendResult> {
  const { raw, threadId } = await prepareReply(opts);
  const gmail = await getGmailClient(opts.account);

  const response = await withRetry(() =>
    gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw, threadId },
    })
  );

  return {
    id: response.data.id || '',
    threadId: response.data.threadId || '',
    labelIds: response.data.labelIds || [],
  };
}

/**
 * Create a draft reply with the same threading semantics as replyToMessage.
 */
export async function createDraftReply(opts: ReplyOpts): Promise<DraftResult> {
  const { raw, threadId } = await prepareReply(opts);
  const gmail = await getGmailClient(opts.account);

  const response = await withRetry(() =>
    gmail.users.drafts.create({
      userId: 'me',
      requestBody: {
        message: { raw, threadId },
      },
    })
  );

  return {
    draft_id: response.data.id || '',
    message: {
      id: response.data.message?.id || '',
      threadId: response.data.message?.threadId || '',
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
    const raw = buildRawMessage({
      from: resolved.email,
      to: mailto.address,
      subject: mailto.subject,
      body: mailto.body,
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
 * Build the body of a forwarded message — optional intro followed by a
 * Gmail-style forwarded-message block. Exported for unit testing.
 */
export function buildForwardBody(opts: {
  intro?: string;
  originalFrom: string;
  originalDate: string;
  originalSubject: string;
  originalTo: string;
  originalCc?: string;
  originalBody: string;
}): string {
  const intro = opts.intro ? `${opts.intro}\n\n` : '';
  const lines = [
    '---------- Forwarded message ----------',
    `From: ${opts.originalFrom}`,
    `Date: ${opts.originalDate}`,
    `Subject: ${opts.originalSubject}`,
    `To: ${opts.originalTo}`,
  ];
  if (opts.originalCc) lines.push(`Cc: ${opts.originalCc}`);
  return `${intro}${lines.join('\n')}\n\n${opts.originalBody}`;
}

/**
 * Forward an existing message to new recipients.
 * Text/HTML body is forwarded; original attachments are NOT re-attached.
 */
export async function forwardMessage(opts: {
  messageId: string;
  to: string;
  account?: string;
  body?: string;
  cc?: string;
  bcc?: string;
  is_html?: boolean;
}): Promise<SendResult> {
  const resolved = resolveAccount(opts.account);
  const gmail = await getGmailClient(resolved);

  const original = await getMessage({ messageId: opts.messageId, account: resolved.email, format: 'full' });

  const originalBody = opts.is_html
    ? (original.body_html || original.body_text)
    : (original.body_text || original.body_html);

  const body = buildForwardBody({
    intro: opts.body,
    originalFrom: original.from,
    originalDate: original.date,
    originalSubject: original.subject,
    originalTo: original.to,
    originalCc: original.cc || undefined,
    originalBody,
  });

  const raw = buildRawMessage({
    from: resolved.email,
    to: opts.to,
    cc: opts.cc,
    bcc: opts.bcc,
    subject: buildForwardSubject(original.subject),
    body,
    is_html: opts.is_html,
  });

  const response = await withRetry(() =>
    gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw },
    })
  );

  return {
    id: response.data.id || '',
    threadId: response.data.threadId || '',
    labelIds: response.data.labelIds || [],
  };
}

/**
 * Fetch the raw bytes of an attachment.
 * Returns data as standard base64 (not base64url), suitable for direct decoding.
 */
export async function getAttachment(opts: {
  messageId: string;
  attachmentId: string;
  account?: string;
}): Promise<AttachmentData> {
  const gmail = await getGmailClient(opts.account);

  const response = await withRetry(() =>
    gmail.users.messages.attachments.get({
      userId: 'me',
      messageId: opts.messageId,
      id: opts.attachmentId,
    })
  );

  // Gmail returns base64url; convert to standard base64 for downstream consumers.
  const data = (response.data.data || '').replace(/-/g, '+').replace(/_/g, '/');
  return {
    attachmentId: opts.attachmentId,
    size: response.data.size || 0,
    data_base64: data,
  };
}

/**
 * List drafts in the user's mailbox. Returns summaries with id + headers.
 */
export async function listDrafts(opts: {
  account?: string;
  maxResults?: number;
}): Promise<DraftSummary[]> {
  const gmail = await getGmailClient(opts.account);
  const maxResults = Math.min(opts.maxResults ?? 100, 500);

  const response = await withRetry(() =>
    gmail.users.drafts.list({ userId: 'me', maxResults })
  );

  const drafts = (response.data.drafts || []).filter(d => d.id && d.message?.id);
  if (drafts.length === 0) return [];

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

  return results;
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
