import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getHistoryBaseline } from '../gmail/client.js';

export const getHistoryBaselineParams = {
  account: z.string().optional().describe('Account alias or email address. Uses default account if not specified.'),
};

export function registerGetHistoryBaseline(server: McpServer): void {
  server.tool(
    'get_history_baseline',
    'Get the mailbox\'s current change cursor (historyId), the starting point for watching '
    + 'for new mail. Returns { account, emailAddress, historyId, messagesTotal, threadsTotal }. '
    + 'Store historyId yourself — the server keeps no state — then call get_mail_changes with '
    + 'it to see what has arrived since. A cursor belongs to ONE account and expires after '
    + 'about a week; call this again for a fresh one whenever get_mail_changes says the cursor '
    + 'is too old. Read-only.',
    getHistoryBaselineParams,
    async ({ account }) => {
      try {
        const result = await getHistoryBaseline({ account: account ?? undefined });

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result, null, 2),
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
