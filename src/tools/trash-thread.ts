import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { trashThread } from '../gmail/client.js';

export const trashThreadParams = {
  thread_id: z.string().describe('The Gmail thread ID to move to trash'),
  account: z.string().optional().describe('Account alias or email address. Uses default account if not specified.'),
};

export function registerTrashThread(server: McpServer): void {
  server.tool(
    'trash_thread',
    'Move an ENTIRE thread to the trash — every message in the conversation, including your own '
    + 'replies. Destructive: confirm with the user before calling it, and use trash_email when '
    + 'only one message should go. Trashed mail is recoverable from Gmail\'s Trash for 30 days. '
    + 'Returns success and the thread id.',
    trashThreadParams,
    async ({ thread_id, account }) => {
      try {
        const result = await trashThread({
          threadId: thread_id,
          account: account ?? undefined,
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ success: result.success, id: result.id }, null, 2),
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
