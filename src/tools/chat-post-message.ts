import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { chat_v1 } from 'googleapis';
import {
  CHAT_MESSAGES_CREATE_SCOPE,
  CHAT_MESSAGES_SCOPE,
  CHAT_SPACES_SCOPE,
  getChatClient,
} from '../chat/client.js';
import { toSpaceParent, toThreadTarget } from '../chat/names.js';
import { type AccountConfig, resolveAccount } from '../config.js';
import { googleApiCall } from '../google-api-error.js';
import { log } from '../log.js';
import { errorStatus } from '../scope-error.js';

/**
 * CP2 — `post_chat_message`, the first and only Chat call this server makes
 * that other people can see.
 *
 * Chat was strictly read-only until 2026-08-28, when the owner withdrew that
 * posture ("lets get chat posting working as well"). The use case is automated
 * alerting from scheduled sessions, so — by the same ruling — there is no
 * confirm parameter: a post is attributed to the account that made it and can
 * be deleted in Chat afterwards, which is the posture `send_email` already
 * has. The honesty is carried by the tool DESCRIPTION instead, which says in
 * its first sentence that real people will see this.
 *
 * Three refusals happen before any network call at all, because each of them
 * is a mistake Google would either accept (and publish) or reject with a
 * sentence nobody can act on:
 *
 *   - empty text — Chat rejects it, but late and unhelpfully;
 *   - text over Chat's 4096-character limit — refusing here means the caller
 *     is told to shorten a message that has NOT been half-posted;
 *   - a thread named in a different space than the one being posted to.
 *
 * CP-1 — the `text` field is NOT inert, and the description used to say it
 * was. Google's own words for it: "Plain-text body of the message. The first
 * link to an image, video, or web page generates a preview chip. You can also
 * @mention a Google Chat user, or everyone in the space." `<users/all>` in the
 * body notifies every member of the space; `<users/{id}>` notifies one person.
 *
 * The text of an alert is routinely composed from something this same server
 * just READ — an email body, a Drive file, a log line — so a literal
 * "<users/all>" quoted out of a ticket at 3am would page a whole room with
 * nobody in the loop to catch it. Mention markup is therefore defused by
 * default (the angle brackets are dropped, so it reads as "users/all" and Chat
 * treats it as ordinary words), and `allow_mentions: true` posts it as written
 * for the case where the mention is the point. The result says how many were
 * defused, so a caller that meant it is not left guessing.
 *
 * Control characters are stripped for the same reason `mime.ts` sanitises
 * headers, though the risk is different: a Chat message body is a JSON string,
 * so there is no header-splitting trick to defend against. What stripping
 * buys is a message that reads as it was meant to — a stray NUL or escape
 * sequence from a log line pasted into an alert renders as a replacement
 * glyph or silently swallows text. Newlines and tabs are kept: they are the
 * formatting a plain-text alert actually uses.
 */

/** Chat's own limit on the text of a message. */
export const CHAT_TEXT_LIMIT = 4096;

/**
 * Remove control characters that would render as noise, keeping the two that
 * carry meaning (newline, tab). Carriage returns are NORMALISED to newlines
 * rather than dropped: dropping the \r out of "a\r\nb" is harmless, but
 * dropping a lone \r would run two lines together into one.
 *
 * Exported for unit testing.
 */
export function sanitizeChatText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

/**
 * Chat's text mention markup: "<users/all>" pages the whole space and
 * "<users/{id}>" pages one person. Nothing else in `text` notifies anybody.
 */
const CHAT_MENTION = /<users\/[^>\s]*>/g;

/**
 * Make Chat mention markup inert by dropping its angle brackets, so
 * "<users/all>" posts as the words "users/all" and notifies nobody.
 *
 * Removing the brackets rather than the whole token is deliberate: the reader
 * still sees what the quoted text said, and the message still gets posted —
 * an alert that refused to send would be a worse 3am outcome than one that
 * reads slightly differently from its source.
 *
 * Exported for unit testing.
 */
export function neutralizeChatMentions(text: string): { text: string; defused: number } {
  let defused = 0;
  const neutralized = text.replace(CHAT_MENTION, (match) => {
    defused += 1;
    return match.slice(1, -1);
  });
  return { text: neutralized, defused };
}

/** Characters as a person counts them, so an emoji costs one, not two. */
export function chatTextLength(text: string): number {
  return Array.from(text).length;
}

export interface PostChatMessageOptions {
  /** Space to post into: "spaces/AAAA..." or the bare id. */
  space: string;
  /** The message, as plain text. */
  text: string;
  /**
   * Reply into an existing thread. Accepts a thread name or the name of a
   * message in the thread (whose thread is then looked up).
   */
  thread?: string;
  /** A key of your own that names a thread across posts. */
  threadKey?: string;
  /**
   * Post Chat mention markup as written, so "<users/all>" really does notify
   * everyone in the space. Default false — see CP-1 in this module's header.
   */
  allowMentions?: boolean;
  /**
   * Chat's idempotency key. Reusing the key of a call that may have landed
   * returns the message it created instead of posting a second one. Defaults
   * to a fresh UUID per call.
   */
  requestId?: string;
  account?: string | AccountConfig;
}

export interface PostChatMessageResult {
  /** The posted message's resource name — pass it to get_chat_message. */
  name: string;
  thread?: string;
  createTime?: string;
  space: string;
  spaceDisplayName?: string;
  account: string;
  /**
   * Only present when a reply was asked for. FALSE means Chat could not use
   * the thread and started a new one instead — the message is posted either
   * way, so this is the difference between "answered them" and "said it into
   * the room".
   */
  repliedToThread?: boolean;
  requestedThread?: string;
  /**
   * How many Chat mentions were made inert before posting. Only present when
   * at least one was — so a caller that meant to page somebody can see that it
   * did not happen, and pass allow_mentions to mean it.
   */
  mentionsDefused?: number;
  /**
   * The idempotency key this post was sent under. Pass it back as
   * "request_id" to retry a call whose outcome you do not know: Chat returns
   * the message already created with that key rather than posting a second.
   */
  requestId: string;
  note?: string;
}

/**
 * Turn a failed post into an error the caller can act on.
 *
 * A gateway failure (5xx, or a network error with no status at all) can arrive
 * AFTER Chat has already accepted the message, so "Service Unavailable" on its
 * own is a trap: the honest reading is "it may or may not be in the space",
 * and the only safe retry is one that carries the same request id. A 4xx —
 * a missing scope, a space the account cannot post to — was refused before
 * anything was created, so it is returned untouched rather than sending
 * somebody hunting for a message that does not exist.
 *
 * The status is read from the RAW Google error at the call site, not from the
 * error handed here: the translation deliberately drops the numeric code (an
 * error carrying `code: 403` would be rewritten by the shared retry helper
 * into "re-authenticate", which is exactly the advice these tools exist to
 * avoid giving), so by this point the code is already gone.
 */
function postFailure(
  err: unknown,
  status: number | undefined,
  parent: string,
  requestId: string,
): unknown {
  const mayHaveLanded = status === undefined || status >= 500;
  if (!mayHaveLanded) return err;

  const original = err instanceof Error ? err.message : String(err);
  const wrapped = new Error(
    `${original}\n\n`
    + `This failure arrived after the message was handed to Google Chat, so it MAY already have `
    + `been posted to ${parent} — check the space before sending it again. To retry without `
    + `risking a second copy, call post_chat_message again with request_id "${requestId}": Chat `
    + `returns the message that key already created instead of posting a new one.`,
    { cause: err },
  );
  const code = (err as { code?: unknown }).code;
  if (code !== undefined) (wrapped as Error & { code?: unknown }).code = code;
  return wrapped;
}

/**
 * Post one message to a Google Chat space.
 *
 * The post itself is NOT retried (`maxRetries: 0`). The shared helper retries
 * 500/502/503/504, and a gateway timeout can arrive after Chat has already
 * accepted the message — retrying then says the same thing twice in front of
 * everyone in the space, and returns the id of only one of them. A failure is
 * reported instead, and the caller decides. The two READS around it (looking a
 * thread up, reading the space's display name) keep the retries, because
 * repeating a read costs nothing.
 *
 * CP-2 — that stops THIS code duplicating a post, but not the caller. An LLM
 * told only "Service Unavailable" will reasonably call the tool again, and
 * that second call is the duplicate. So every post carries Chat's own
 * idempotency key (`requestId`), the failure says the message may already be
 * in the space, and it names the key to retry with. Retrying under the same
 * key returns the message that key already created.
 */
export async function postChatMessage(opts: PostChatMessageOptions): Promise<PostChatMessageResult> {
  const resolved = typeof opts.account === 'string' || opts.account === undefined
    ? resolveAccount(opts.account)
    : opts.account;

  const parent = toSpaceParent(opts.space ?? '');

  // Defusing runs BEFORE the length check, because it only ever shortens the
  // text: a message that fits after defusing is not refused for a length it no
  // longer has.
  const sanitized = sanitizeChatText(opts.text ?? '');
  const defused = opts.allowMentions === true
    ? { text: sanitized, defused: 0 }
    : neutralizeChatMentions(sanitized);
  const mentionsDefused = defused.defused;

  const text = defused.text.trim();
  if (text.length === 0) {
    throw new Error(
      'post_chat_message: text is required — an empty message is refused here rather than '
      + 'sent to Chat to be rejected.',
    );
  }

  const length = chatTextLength(text);
  if (length > CHAT_TEXT_LIMIT) {
    throw new Error(
      `post_chat_message: the message is ${length} characters and Google Chat's limit is `
      + `${CHAT_TEXT_LIMIT}. Nothing was posted — shorten it, or split it into more than one `
      + 'message (post the first, then reply into the thread it returns).',
    );
  }

  const threadKey = opts.threadKey?.trim() || undefined;
  const requestedThreadInput = opts.thread?.trim() || undefined;

  if (requestedThreadInput && threadKey) {
    throw new Error(
      'post_chat_message: pass either "thread" or "thread_key", not both — they are two ways '
      + 'of naming the thread and Chat honours only one. Use "thread" to answer a message you '
      + 'have in hand, "thread_key" to keep repeated alerts of your own together.',
    );
  }

  // Parsing before the client is built, so a malformed thread costs no token
  // work and no network call.
  const target = requestedThreadInput ? toThreadTarget(parent, requestedThreadInput) : undefined;

  // Chat's own idempotency key, generated per call unless the caller brought
  // one. A caller that retries with the same key gets the message that key
  // already created, instead of a second copy in front of the space.
  const requestId = opts.requestId?.trim() || randomUUID();

  const chat = await getChatClient(resolved);
  const postCtx = {
    tool: 'post_chat_message',
    api: 'Google Chat',
    scope: CHAT_MESSAGES_CREATE_SCOPE,
    alias: resolved.alias,
  };

  // A message name has to be resolved to its thread first — Chat replies are
  // addressed by thread, and the two ids differ.
  let requestedThread: string | undefined;
  if (target?.kind === 'thread') {
    requestedThread = target.name;
  } else if (target?.kind === 'message') {
    const lookup = await googleApiCall(
      { ...postCtx, scope: CHAT_MESSAGES_SCOPE },
      () => chat.spaces.messages.get({ name: target.name }),
    );
    requestedThread = lookup.data.thread?.name ?? undefined;
    if (!requestedThread) {
      throw new Error(
        `post_chat_message: Chat returned no thread for "${target.name}", so there is nothing to `
        + 'reply into. Nothing was posted — post without "thread" to start a new one.',
      );
    }
  }

  const fields = {
    account: resolved.alias,
    space: parent,
    text_chars: length,
    thread: requestedThread ?? null,
    thread_key: threadKey ?? null,
    mentions_defused: mentionsDefused,
    request_id: requestId,
  };
  log('info', 'post_chat_message', { ...fields, phase: 'start' });

  const thread: chat_v1.Schema$Thread | undefined = requestedThread
    ? { name: requestedThread }
    : threadKey
      ? { threadKey }
      : undefined;

  let response;
  // The status of the RAW error, kept before the honest-error translation
  // discards it — it is what says whether the message could already be in the
  // space. There is exactly one attempt (maxRetries: 0), so it is unambiguous.
  let rawStatus: number | undefined;
  try {
    response = await googleApiCall(postCtx, async () => {
      try {
        return await chat.spaces.messages.create({
          parent,
          // Chat's idempotency key. It costs nothing on a call that succeeds,
          // and it is the only thing that makes a RETRY safe — see the note on
          // the thrown error below.
          requestId,
          // Chat's own words for "put it in that thread if you can, and if you
          // cannot, say it in the space rather than failing". The caller is TOLD
          // which of the two happened, below.
          ...(thread ? { messageReplyOption: 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD' } : {}),
          requestBody: {
            text,
            ...(thread ? { thread } : {}),
          },
        });
      } catch (raw: unknown) {
        rawStatus = errorStatus(raw);
        throw raw;
      }
      },
      // See postChatMessage's note: a retried post is a duplicate message.
      { maxRetries: 0 },
    );
  } catch (err: unknown) {
    log('error', 'post_chat_message', {
      ...fields,
      phase: 'failed',
      error: err instanceof Error ? err.message : String(err),
    });
    throw postFailure(err, rawStatus, parent, requestId);
  }

  const posted = response.data;
  const landedThread = posted.thread?.name ?? undefined;

  const result: PostChatMessageResult = {
    name: posted.name ?? '',
    ...(landedThread ? { thread: landedThread } : {}),
    ...(posted.createTime ? { createTime: posted.createTime } : {}),
    space: parent,
    account: resolved.alias,
    requestId,
  };

  const notes: string[] = [];

  if (requestedThread) {
    const replied = landedThread === requestedThread;
    result.requestedThread = requestedThread;
    result.repliedToThread = replied;
    if (!replied) {
      notes.push(
        `The message was posted, but NOT into the thread that was asked for: Chat `
        + `could not use "${requestedThread}" and started a new thread instead`
        + `${landedThread ? ` ("${landedThread}")` : ''}. Everyone in the space sees it either way.`,
      );
    }
  } else if (threadKey) {
    notes.push(
      `Posted under thread_key "${threadKey}": later posts with the same key join this thread.`,
    );
  }

  if (mentionsDefused > 0) {
    notes.push(
      `${mentionsDefused} Chat @mention${mentionsDefused === 1 ? ' was' : 's were'} made inert `
      + 'before posting, so nobody was notified by the message text. Pass '
      + '"allow_mentions": true to post the mention as written.',
    );
    result.mentionsDefused = mentionsDefused;
  }

  if (notes.length > 0) result.note = notes.join(' ');

  log('info', 'post_chat_message', {
    ...fields,
    phase: 'done',
    message: result.name,
    landed_thread: landedThread ?? null,
    replied_to_thread: result.repliedToThread ?? null,
  });

  // The display name is a courtesy, fetched AFTER the post so that a read
  // failure — a token without chat.spaces.readonly, say — can never stop a
  // message that was going to be fine, or make a posted message look failed.
  try {
    const space = await googleApiCall(
      { ...postCtx, tool: 'post_chat_message', scope: CHAT_SPACES_SCOPE },
      () => chat.spaces.get({ name: parent }),
    );
    if (space.data.displayName) result.spaceDisplayName = space.data.displayName;
  } catch {
    // Deliberately silent: the post already succeeded and this adds nothing
    // the caller needs.
  }

  return result;
}

export const postChatMessageParams = {
  space: z
    .string()
    .describe(
      'The Chat space to post into. Accepts a full resource name ("spaces/AAAA...") or a bare '
      + 'space id ("AAAA..."). list_chat_spaces returns these.',
    ),
  text: z
    .string()
    .describe(
      'The message body — this is what people in the space will read. It is NOT inert text: '
      + 'Chat renders a little markup of its own (*bold*, _italic_, `code`), the FIRST link in '
      + 'it becomes a preview chip, and Chat mention markup notifies people — "<users/all>" '
      + 'notifies EVERYONE in the space and "<users/{id}>" notifies that person. Markdown '
      + 'headings arrive as literal characters. Because message text is often quoted from an '
      + 'email, a file or a log, mention markup is made inert before posting (the angle '
      + 'brackets are dropped, so it reads as "users/all") and the answer says how many were '
      + 'defused; pass "allow_mentions": true when the mention is deliberate. Newlines and tabs '
      + 'are kept; other control characters are stripped. Chat allows up to 4096 characters and '
      + 'a longer message is refused before anything is posted.',
    ),
  allow_mentions: z
    .boolean()
    .optional()
    .describe(
      'Post Chat mention markup as written, so "<users/all>" really does notify every member '
      + 'of the space and "<users/{id}>" notifies that person. Defaults to false, which makes '
      + 'such markup inert. Only pass true when you intend to notify people.',
    ),
  thread: z
    .string()
    .optional()
    .describe(
      'Reply into an existing thread instead of starting a new one. Accepts a thread name '
      + '("spaces/A/threads/T") or the name of a message in that thread '
      + '("spaces/A/messages/M", exactly as list_chat_messages returns it) — the thread is '
      + 'looked up from the message. If Chat cannot use the thread it posts to the space as a '
      + 'NEW thread rather than failing; the answer says which happened '
      + '("repliedToThread": true/false).',
    ),
  thread_key: z
    .string()
    .optional()
    .describe(
      'A key of your own choosing that names a thread across posts: every message posted with '
      + 'the same thread_key in the same space joins the same thread. Use it for a recurring '
      + 'alert that should stay in one conversation. Cannot be combined with "thread".',
    ),
  request_id: z
    .string()
    .optional()
    .describe(
      'An idempotency key for this post. Leave it unset for a normal call — one is generated '
      + 'and returned as "requestId". Pass it back ONLY when retrying a call whose outcome you '
      + 'do not know (it failed with a message saying it may already have been posted): Chat '
      + 'returns the message that key already created instead of posting a second copy.',
    ),
  account: z
    .string()
    .optional()
    .describe('Account alias or email address. Uses default account if not specified.'),
};

/**
 * WRITE: post a message to a Google Chat space.
 */
export function registerPostChatMessage(server: McpServer): void {
  server.tool(
    'post_chat_message',
    'Posts a real message that people in that space will see, sent as the account you name '
    + '(the "account" parameter, or the default account). It appears in Chat the moment this '
    + 'returns — there is no draft, no preview, and no confirmation step, the same posture '
    + 'send_email has. The post is attributed to that account and its author can delete it in '
    + 'Chat afterwards. '
    + 'Returns the message name, the thread it landed in, createTime, the space and its display '
    + 'name, and the posting account. '
    + 'The message text is not inert: the first link in it becomes a preview chip, and Chat '
    + 'mention markup ("<users/all>", "<users/{id}>") notifies people — so mention markup is '
    + 'made inert before posting unless you pass "allow_mentions": true. '
    + 'Pass "thread" to reply inside an existing conversation, or "thread_key" to keep repeated '
    + 'alerts together; when a reply cannot be threaded, Chat posts it as a new thread and the '
    + 'answer says so ("repliedToThread": false). '
    + 'The post is never retried automatically, because a retried post is a second message in '
    + 'front of everybody. If it fails with a gateway error the message MAY still have been '
    + 'posted; the error says so, and names the "request_id" to retry with so Chat returns the '
    + 'message already created rather than posting another. '
    + 'Needs the "chat.messages.create" scope, added 2026-08-28 — until an account re-consents '
    + 'with "npm run auth -- <alias>" this returns an error naming that exact scope. '
    + 'Nothing here edits or deletes an existing message.',
    postChatMessageParams,
    async ({ space, text, thread, thread_key, allow_mentions, request_id, account }) => {
      try {
        const result = await postChatMessage({
          space,
          text,
          thread: thread ?? undefined,
          threadKey: thread_key ?? undefined,
          allowMentions: allow_mentions ?? undefined,
          requestId: request_id ?? undefined,
          account: account ?? undefined,
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ success: true, ...result }, null, 2),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
