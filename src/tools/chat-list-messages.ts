import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { chat_v1 } from 'googleapis';
import { getChatClient } from '../chat/client.js';
import { withRetry } from '../gmail/client.js';

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
 * Normalize a space id or full resource name into "spaces/{id}".
 */
function toSpaceParent(space: string): string {
  const trimmed = space.trim();
  return trimmed.startsWith('spaces/') ? trimmed : `spaces/${trimmed}`;
}

/**
 * READ-ONLY: list messages in a Chat space.
 */
export function registerListChatMessages(server: McpServer): void {
  server.tool(
    'list_chat_messages',
    'List messages in a Google Chat space. Read-only. Requires a space name/id. Returns the raw '
    + 'Chat message objects, newest first by default (order_by "createTime asc" for oldest '
    + 'first).',
    listChatMessagesParams,
    async ({ space, account, filter, max_results, order_by }) => {
      try {
        const chat = await getChatClient(account ?? undefined);
        const parent = toSpaceParent(space);
        const maxResults = Math.min(max_results ?? 500, 1000);
        // Newest-first: with the API's own ascending default, max_results would
        // truncate the space to its oldest messages.
        const orderBy = order_by || 'createTime desc';

        const messages: chat_v1.Schema$Message[] = [];
        let pageToken: string | undefined;

        while (messages.length < maxResults) {
          const pageSize = Math.min(maxResults - messages.length, 1000);
          const response = await withRetry(() =>
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
              text: JSON.stringify(messages.slice(0, maxResults), null, 2),
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
