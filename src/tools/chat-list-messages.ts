import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { chat_v1 } from 'googleapis';
import { CHAT_MESSAGES_SCOPE, getChatClient } from '../chat/client.js';
import { toSpaceParent } from '../chat/names.js';
import { resolveAccount } from '../config.js';
import { googleApiCall } from '../google-api-error.js';

export const listChatMessagesParams = {
  space: z.string().describe('The Chat space to list messages from. Accepts a full resource name ("spaces/AAAA...") or a bare space id ("AAAA...").'),
  account: z.string().optional().describe('Account alias or email address. Uses default account if not specified.'),
  filter: z.string().optional().describe('Optional Chat API filter, e.g. \'createTime > "2024-01-01T00:00:00Z"\'.'),
  max_results: z.number().optional().describe('Maximum number of messages to return (default: 500, max: 1000). Paginates automatically.'),
  order_by: z
    .string()
    .optional()
    .describe(
      'Chat API ordering, default "createTime desc" (newest first). Pass "createTime asc" for '
      + 'the oldest first. The Chat API itself defaults to ascending, which means max_results '
      + 'would truncate a space to its OLDEST messages — the opposite of what capping a list '
      + 'usually means — so this tool defaults to descending instead.',
    ),
};

/**
 * The fields a Chat message listing is actually read for: who said what, when,
 * and in which thread.
 *
 * The raw Message object carries the space it belongs to (repeated in full on
 * EVERY message), annotations, card payloads, reaction summaries, and three
 * more copies of the text under different names. A listing of 500 messages was
 * spending most of its size on that, and the description promised "the raw Chat
 * message objects", which told Claude to expect the noise.
 *
 * Two things are deliberately kept beyond the obvious:
 *
 * - `attachments`, reduced to name + type. Dropping them entirely would make
 *   "here's the report" look like a message with nothing attached, which is a
 *   silent lie rather than a saving.
 * - `fallbackText`, but only when `text` is empty. A card-only message (a build
 *   notification, an alert) has no `text` at all, and would otherwise read as an
 *   empty message from a bot.
 *
 * Exported for unit testing.
 */
export function projectChatMessage(message: chat_v1.Schema$Message): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (message.name != null) out.name = message.name;

  if (message.sender != null) {
    const sender: Record<string, unknown> = {};
    if (message.sender.name != null) sender.name = message.sender.name;
    if (message.sender.displayName != null) sender.displayName = message.sender.displayName;
    if (message.sender.type != null) sender.type = message.sender.type;
    out.sender = sender;
  }

  if (message.createTime != null) out.createTime = message.createTime;
  if (message.text != null) out.text = message.text;
  if (!message.text && message.fallbackText) out.fallbackText = message.fallbackText;
  if (message.thread?.name != null) out.thread = message.thread.name;

  // A deleted message and an edited one used to project identically to an
  // ordinary one — name, sender, createTime, text — because deletionMetadata
  // and lastUpdateTime were dropped with the rest of the raw object. A reader
  // summarising a space could then quote a message the author had retracted, or
  // an old wording as though it were the current one, with nothing in the
  // answer to warn them. The markers are stated outright rather than handing
  // back Chat's raw fields: a consumer should not have to know that
  // "deleteTime is set" is how Chat says deleted.
  if (message.deletionMetadata != null || message.deleteTime != null) {
    out.deleted = true;
    if (message.deleteTime != null) out.deleteTime = message.deleteTime;
    if (message.deletionMetadata?.deletionType != null) {
      out.deletedBy = message.deletionMetadata.deletionType;
    }
  }

  if (message.lastUpdateTime != null) {
    out.edited = true;
    out.lastUpdateTime = message.lastUpdateTime;
  }

  const attachments = (message.attachment ?? [])
    .map(a => ({
      ...(a.contentName != null ? { contentName: a.contentName } : {}),
      ...(a.contentType != null ? { contentType: a.contentType } : {}),
    }))
    .filter(a => Object.keys(a).length > 0);
  if (attachments.length > 0) out.attachments = attachments;

  return out;
}

/**
 * READ-ONLY: list messages in a Chat space.
 */
export function registerListChatMessages(server: McpServer): void {
  server.tool(
    'list_chat_messages',
    'List messages in a Google Chat space. Read-only. Requires a space name/id. '
    + 'Returns, per message: name, sender (name, displayName, type), createTime, text, and '
    + 'thread — plus attachments (contentName, contentType) when a file was shared, and '
    + 'fallbackText when the message is a card with no text of its own. '
    + 'A message that was deleted carries deleted: true (with deleteTime and deletedBy when '
    + 'Chat reports them) and usually has no text left; one that was edited carries '
    + 'edited: true and lastUpdateTime, and its text is the CURRENT wording, not what was '
    + 'first sent. Both markers are absent on an ordinary message — do not quote a deleted '
    + 'message as though it still stands. '
    + 'Newest first by default (order_by "createTime asc" for oldest first).',
    listChatMessagesParams,
    async ({ space, account, filter, max_results, order_by }) => {
      try {
        const resolved = resolveAccount(account ?? undefined);
        const chat = await getChatClient(resolved);
        const ctx = { tool: 'list_chat_messages', api: 'Google Chat', scope: CHAT_MESSAGES_SCOPE, alias: resolved.alias };
        const parent = toSpaceParent(space);
        const maxResults = Math.min(max_results ?? 500, 1000);
        // Newest-first: with the API's own ascending default, max_results would
        // truncate the space to its oldest messages.
        const orderBy = order_by || 'createTime desc';

        const messages: chat_v1.Schema$Message[] = [];
        let pageToken: string | undefined;

        while (messages.length < maxResults) {
          const pageSize = Math.min(maxResults - messages.length, 1000);
          const response = await googleApiCall(ctx, () =>
            chat.spaces.messages.list({
              parent,
              pageSize,
              pageToken,
              filter: filter || undefined,
              orderBy,
            })
          );

          const page = response.data.messages || [];
          messages.push(...page);

          pageToken = response.data.nextPageToken ?? undefined;
          if (!pageToken || page.length === 0) break;
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(messages.slice(0, maxResults).map(projectChatMessage), null, 2),
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
