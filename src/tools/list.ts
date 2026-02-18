import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { listMessages } from '../gmail/client.js';

export const listEmailsParams = {
  account: z.string().optional().describe('Account alias or email address. Uses default account if not specified.'),
  label: z.string().optional().describe('Gmail label ID to filter by (default: INBOX)'),
  max_results: z.number().optional().describe('Maximum number of emails to return (default: 500, max: 1000). Paginates automatically.'),
  query: z.string().optional().describe('Gmail search query to filter results'),
};

export function registerListEmails(server: McpServer): void {
  server.tool(
    'list_emails',
    'List emails from an account inbox or label. Returns summaries with id, from, subject, date, snippet, and unread status.',
    listEmailsParams,
    async ({ account, label, max_results, query }) => {
      try {
        const results = await listMessages({
          account: account ?? undefined,
          label: label ?? undefined,
          maxResults: max_results ?? undefined,
          query: query ?? undefined,
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
