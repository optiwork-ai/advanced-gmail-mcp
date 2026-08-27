/**
 * Shared types for the Gmail MCP server.
 */

/** Summary of an email for list/search results. */
export interface EmailSummary {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  snippet: string;
  labels: string[];
  isUnread: boolean;
}

/** Full email with body content. */
export interface EmailFull {
  id: string;
  threadId: string;
  from: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  date: string;
  body_text: string;
  body_html: string;
  labels: string[];
  attachments: AttachmentInfo[];
  list_unsubscribe: string;
  list_unsubscribe_post: string;
}

/** Result from unsubscribe operations. */
export interface UnsubscribeResult {
  success: boolean;
  method: 'mailto' | 'https' | 'none';
  detail: string;
}

/** Attachment metadata (no content). */
export interface AttachmentInfo {
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
}

/** Result from fetching an attachment. */
export interface AttachmentData {
  attachmentId: string;
  /** The filename carried by the message part (sanitized), or 'attachment'. */
  filename: string;
  mimeType: string;
  /** Decoded byte size. */
  size: number;
  /**
   * Standard, padded base64. Present only when the bytes were returned inline —
   * i.e. no `save_dir` was given and the attachment was small enough to inline.
   */
  data_base64?: string;
  /** Absolute path of the file written. Present only when `save_dir` was given. */
  path?: string;
}

/** Thread with its messages. */
export interface ThreadInfo {
  id: string;
  messages: ThreadMessage[];
}

/** A message within a thread (lighter than EmailFull). */
export interface ThreadMessage {
  id: string;
  from: string;
  to: string;
  cc: string;
  subject: string;
  date: string;
  body_text: string;
  snippet: string;
  labels: string[];
}

/** Label metadata. */
export interface LabelInfo {
  id: string;
  name: string;
  type: string;
  messagesTotal: number;
  messagesUnread: number;
}

/** A file attached to an outbound message, already loaded into memory. */
export interface Attachment {
  /** Basename, already sanitized of CR/LF and quotes. */
  filename: string;
  mimeType: string;
  content: Buffer;
}

/** The account's Gmail sendAs settings (display name, signature, reply-to). */
export interface SendAsProfile {
  email: string;
  /** '' when unset. */
  displayName: string;
  /** '' when unset. HTML, as Gmail stores it. */
  signatureHtml: string;
  /** '' when unset. */
  replyTo: string;
}

/** Options shared by every outbound composition path. */
export interface ComposeOptions {
  /** Append the account's Gmail signature. Default true. */
  include_signature?: boolean;
  /** Absolute file paths to attach. */
  attachments?: string[];
}

/** Send/draft message input. */
export interface ComposeInput extends ComposeOptions {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
  is_html?: boolean;
}

/** Reply message input. */
export interface ReplyInput extends ComposeOptions {
  message_id: string;
  body: string;
  is_html?: boolean;
  reply_all?: boolean;
  cc?: string;
  bcc?: string;
  /** Include the quoted original below the reply, as Gmail does. Default true. */
  include_quote?: boolean;
}

/** Result from send/draft operations. */
export interface SendResult {
  id: string;
  threadId: string;
  labelIds: string[];
}

/** Result from draft creation. */
export interface DraftResult {
  draft_id: string;
  message: {
    id: string;
    threadId: string;
  };
}

/** Summary of a draft for listing. */
export interface DraftSummary {
  draft_id: string;
  message_id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  snippet: string;
}

/** Full content of a draft. */
export interface DraftFull {
  draft_id: string;
  message: EmailFull;
}

/** Result from modify operations. */
export interface ModifyResult {
  success: boolean;
  id: string;
  labels?: string[];
}

/** Result from batch operations. */
export interface BatchResult {
  success: boolean;
  modified_count: number;
  message_ids: string[];
}

/** OAuth token shape stored on disk. */
export interface StoredToken {
  access_token: string;
  refresh_token: string;
  scope: string;
  token_type: string;
  expiry_date: number;
}
