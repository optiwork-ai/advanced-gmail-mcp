import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { searchMessages } from '../gmail/client.js';

export const searchEmailsParams = {
  query: z.string().describe('Gmail search query (e.g. "from:alice subject:report after:2024/01/01")'),
  account: z.string().optional().describe('Account alias or email address. Uses default account if not specified.'),
  max_results: z.number().optional().describe('Maximum number of results to return (default: 500, max: 1000). Paginates automatically.'),
};

export function registerSearchEmails(server: McpServer): void {
  server.tool(
    'search_emails',
    'Search emails using Gmail query syntax. Returns summaries with id, from, subject, date, snippet, and unread status.',
    searchEmailsParams,
    async ({ query, account, max_results }) => {
      try {
        const results = await searchMessages({
          query,
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
