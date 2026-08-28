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

/** One page of message summaries plus the cursor for the next one. */
export interface MessagePage {
  messages: EmailSummary[];
  /** Pass back as `page_token` to fetch the next page. Absent on the last page. */
  nextPageToken?: string;
}

/** One page of draft summaries plus the cursor for the next one. */
export interface DraftPage {
  drafts: DraftSummary[];
  /** Pass back as `page_token` to fetch the next page. Absent on the last page. */
  nextPageToken?: string;
}

/**
 * The mailbox cursor a mail-arrival watcher stores between polls.
 *
 * `historyId` is a uint64 and is kept as a STRING on purpose: live values
 * already exceed what a JS number represents exactly, and a rounded cursor
 * silently skips or replays mail.
 */
export interface HistoryBaseline {
  /** The alias the cursor belongs to. A cursor is meaningless on another account. */
  account: string;
  emailAddress: string;
  historyId: string;
  messagesTotal?: number;
  threadsTotal?: number;
}

/** A message named by a history record, without a metadata fetch. */
export interface HistoryMessageRef {
  id: string;
  threadId: string;
  /**
   * For the label categories, the label ids the event added or removed, unioned
   * across every record in the page. For deletions, whatever labels the record
   * carried.
   */
  labelIds?: string[];
}

/**
 * One page of mailbox changes since a cursor.
 *
 * The cursor is remembered per account on this machine (G12): a poll with no
 * `history_id` continues from the last COMPLETE read. A caller that keeps its
 * own cursor and passes it in still overrides that.
 */
export interface MailChanges {
  /** The alias these changes came from. */
  account: string;
  /** The cursor that was polled. */
  fromHistoryId: string;
  /**
   * Present only when the polled cursor came from the remembered position
   * rather than from the caller — the reason `fromHistoryId` is a value the
   * caller never sent.
   */
  resumedFrom?: string;
  /**
   * The cursor for the NEXT poll. Store it only when `complete` is true — while
   * pages remain, the mailbox has already moved past what this page reports.
   */
  historyId: string;
  /** True when this is the last page for `fromHistoryId`. */
  complete: boolean;
  /** Present when more pages remain. Call again with the SAME `history_id`. */
  nextPageToken?: string;
  /** Messages that arrived (or were inserted) since the cursor. */
  added: EmailSummary[];
  /** Messages deleted since the cursor. They cannot be fetched, so ids only. */
  deleted: HistoryMessageRef[];
  labelsAdded: HistoryMessageRef[];
  labelsRemoved: HistoryMessageRef[];
  /** Set when something about this page needs saying (an unhydrated tail). */
  note?: string;
}

/**
 * Headers-only result for `read_email` with format 'metadata' or 'minimal'.
 * Distinguished from EmailFull by the explicit `body_note`, so a caller can
 * never mistake a body-free response for an empty message.
 */
export interface EmailHeadersOnly {
  id: string;
  threadId: string;
  from: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  date: string;
  labels: string[];
  snippet: string;
  /** Always set. Explains why there is no body and how to get one. */
  body_note: string;
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

/**
 * Attachment metadata (no content).
 *
 * "Attachment" here means any downloadable part, including an image embedded in
 * the body. Those are marked `inline` and carry the `contentId` the body's
 * `cid:` reference resolves against; listing only the parts with a filename hid
 * every embedded image from `read_email`, `get_thread` and `get_attachment`.
 */
export interface AttachmentInfo {
  /**
   * Gmail's handle for the BYTES. It is not stable: two consecutive
   * `messages.get` calls on the same message can return different
   * attachmentIds for the same part, so it must never be used as the identity
   * of a part across fetches. `partId` is the stable key.
   */
  attachmentId: string;
  /**
   * Gmail's position of this part inside the message payload ("0", "0.1", …).
   * Stable across fetches, which is what makes it usable as an identifier —
   * pass it back to `get_attachment` as `part_id`. Absent only when Gmail
   * omitted it (an unusual payload, or a hand-built test message).
   */
  partId?: string;
  filename: string;
  mimeType: string;
  size: number;
  /** True for a part meant to render inside the body rather than hang off it. */
  inline?: boolean;
  /** The Content-ID, angle brackets stripped. Present on inline parts. */
  contentId?: string;
}

/** Result from fetching an attachment. */
export interface AttachmentData {
  attachmentId: string;
  /**
   * The stable part key this fetch was matched to. Present whenever the part
   * was identified and Gmail supplied one; pass it back as `part_id` on a
   * later fetch of the same attachment.
   */
  partId?: string;
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
  /**
   * Present ONLY when the message part could not be identified, in which case
   * `filename` and `mimeType` above are placeholders. It says so in words and
   * names the way out (`part_id`), because the silent version of this — an
   * unnamed `application/octet-stream` — reads as a fact rather than a failure.
   */
  note?: string;
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
  /** Falls back to the flattened HTML when the message has no text/plain part. */
  body_text: string;
  snippet: string;
  labels: string[];
  attachments: AttachmentInfo[];
}

/**
 * Label metadata.
 *
 * The counts are OPTIONAL on purpose: `labels.list` never returns them, and
 * coercing their absence to `0` made every label report 0/0 while the tool
 * description promised real counts. They appear only when actually fetched
 * (get_labels with include_counts).
 */
export interface LabelInfo {
  id: string;
  name: string;
  type: string;
  messagesTotal?: number;
  messagesUnread?: number;
  textColor?: string;
  backgroundColor?: string;
}

/** A file attached to an outbound message, already loaded into memory. */
export interface Attachment {
  /** Basename, already sanitized of CR/LF and quotes. */
  filename: string;
  mimeType: string;
  content: Buffer;
}

/**
 * An image embedded in the HTML body rather than listed as a file.
 *
 * `contentId` is what an `<img src="cid:...">` in the body refers to. It is
 * derived from the file's basename so the composing model can predict it
 * without a round trip.
 */
export interface InlineImage extends Attachment {
  contentId: string;
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

/**
 * Result from batch operations.
 *
 * `message_ids` is what actually SUCCEEDED, not the input array — a partial
 * failure used to be invisible because the tool synthesized success from its
 * own arguments and discarded what the API said.
 */
export interface BatchResult {
  success: boolean;
  modified_count: number;
  message_ids: string[];
  /** Present only when something failed. One entry per failed chunk (or id). */
  failures?: Array<{ ids: string[]; error: string }>;
}

/** OAuth token shape stored on disk. */
export interface StoredToken {
  access_token: string;
  refresh_token: string;
  scope: string;
  token_type: string;
  expiry_date: number;
}
