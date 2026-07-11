import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { chat_v1 } from 'googleapis';
import { getChatClient } from '../chat/client.js';
import { withRetry } from '../gmail/client.js';

export const listChatSpacesParams = {
  account: z.string().optional().describe('Account alias or email address. Uses default account if not specified.'),
  filter: z.string().optional().describe('Optional Chat API filter, e.g. \'spaceType = "SPACE"\' or \'spaceType = "DIRECT_MESSAGE"\'.'),
  max_results: z.number().optional().describe('Maximum number of spaces to return (default: 500, max: 1000). Paginates automatically.'),
};

/**
 * READ-ONLY: list the Chat spaces the account is a member of.
 */
export function registerListChatSpaces(server: McpServer): void {
  server.tool(
    'list_chat_spaces',
    'List the Google Chat spaces (rooms and direct messages) the account is a member of. Read-only. Returns name, displayName, spaceType, and spaceDetails.',
    listChatSpacesParams,
    async ({ account, filter, max_results }) => {
      try {
        const chat = await getChatClient(account ?? undefined);
        const maxResults = Math.min(max_results ?? 500, 1000);

        const spaces: chat_v1.Schema$Space[] = [];
        let pageToken: string | undefined;

        while (spaces.length < maxResults) {
          const pageSize = Math.min(maxResults - spaces.length, 1000);
          const response = await withRetry(() =>
            chat.spaces.list({
              pageSize,
              pageToken,
              filter: filter || undefined,
            })
          );

          const page = response.data.spaces || [];
          spaces.push(...page);

          pageToken = response.data.nextPageToken ?? undefined;
          if (!pageToken || page.length === 0) break;
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(spaces.slice(0, maxResults), null, 2),
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
