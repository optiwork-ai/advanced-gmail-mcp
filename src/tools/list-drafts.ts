import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { listDrafts } from '../gmail/client.js';

export const listDraftsParams = {
  account: z.string().optional().describe('Account alias or email address. Uses default account if not specified.'),
  max_results: z.number().optional().describe('Drafts to return in this page (default: 100, max: 500).'),
  page_token: z.string().optional().describe('Cursor for the next page: pass back the nextPageToken from a previous call.'),
};

export function registerListDrafts(server: McpServer): void {
  server.tool(
    'list_drafts',
    'List drafts in the account. Returns { drafts, nextPageToken }; each draft summary carries '
    + 'draft_id, message_id, threadId, from, to, subject, date and snippet. Pass nextPageToken '
    + 'back as page_token for the next page.',
    listDraftsParams,
    async ({ account, max_results, page_token }) => {
      try {
        const results = await listDrafts({
          account: account ?? undefined,
          maxResults: max_results ?? undefined,
          pageToken: page_token ?? undefined,
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(results, null, 2),
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
