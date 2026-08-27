import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { listMessages } from '../gmail/client.js';

export const listEmailsParams = {
  account: z.string().optional().describe('Account alias or email address. Uses default account if not specified.'),
  label: z.string().optional().describe('Gmail label ID to filter by (default: INBOX). This is an ID, not a name — get it from get_labels.'),
  max_results: z.number().optional().describe('Emails to return in this page (default: 50, max: 500). Ask for more only when you will actually read them.'),
  query: z.string().optional().describe('Gmail search query to narrow the results WITHIN the label. Combined with label using AND, so it cannot reach mail outside it — use search_emails to search the whole mailbox.'),
  page_token: z.string().optional().describe('Cursor for the next page: pass back the nextPageToken from a previous call.'),
};

export function registerListEmails(server: McpServer): void {
  server.tool(
    'list_emails',
    'List emails from an account inbox or label. Returns { messages, nextPageToken } where each '
    + 'message is a summary with id, threadId, from, subject, date, snippet, and unread status. '
    + 'label and query are ANDed: a query here searches only inside the chosen label (INBOX by '
    + 'default), so use search_emails to search the whole mailbox. Pass nextPageToken back as '
    + 'page_token for the next page.',
    listEmailsParams,
    async ({ account, label, max_results, query, page_token }) => {
      try {
        const results = await listMessages({
          account: account ?? undefined,
          label: label ?? undefined,
          maxResults: max_results ?? undefined,
          query: query ?? undefined,
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
