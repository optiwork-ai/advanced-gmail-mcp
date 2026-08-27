import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { searchMessages } from '../gmail/client.js';

export const searchEmailsParams = {
  query: z.string().describe('Gmail search query (e.g. "from:alice subject:report after:2024/01/01")'),
  account: z.string().optional().describe('Account alias or email address. Uses default account if not specified.'),
  max_results: z.number().optional().describe('Results to return in this page (default: 50, max: 500). Ask for more only when you will actually read them.'),
  page_token: z.string().optional().describe('Cursor for the next page: pass back the nextPageToken from a previous call.'),
};

export function registerSearchEmails(server: McpServer): void {
  server.tool(
    'search_emails',
    'Search emails across the whole mailbox using Gmail query syntax. Returns '
    + '{ messages, nextPageToken } where each message is a summary with id, threadId, from, '
    + 'subject, date, snippet, and unread status. Pass nextPageToken back as page_token for '
    + 'the next page.',
    searchEmailsParams,
    async ({ query, account, max_results, page_token }) => {
      try {
        const results = await searchMessages({
          query,
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
