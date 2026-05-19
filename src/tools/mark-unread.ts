import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { modifyMessage } from '../gmail/client.js';

export const markUnreadParams = {
  message_id: z.string().describe('The Gmail message ID to mark as unread'),
  account: z.string().optional().describe('Account alias or email address. Uses default account if not specified.'),
};

export function registerMarkUnread(server: McpServer): void {
  server.tool(
    'mark_unread',
    'Mark an email as unread by adding the UNREAD label.',
    markUnreadParams,
    async ({ message_id, account }) => {
      try {
        const result = await modifyMessage({
          messageId: message_id,
          addLabelIds: ['UNREAD'],
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
