import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { listDrafts } from '../gmail/client.js';

export const listDraftsParams = {
  account: z.string().optional().describe('Account alias or email address. Uses default account if not specified.'),
  max_results: z.number().optional().describe('Maximum drafts to return (default 100, max 500).'),
};

export function registerListDrafts(server: McpServer): void {
  server.tool(
    'list_drafts',
    'List drafts in the account. Returns summaries with draft_id, message_id, to, subject, date, snippet.',
    listDraftsParams,
    async ({ account, max_results }) => {
      try {
        const results = await listDrafts({
          account: account ?? undefined,
          maxResults: max_results ?? undefined,
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
