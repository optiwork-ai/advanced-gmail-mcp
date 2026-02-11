import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { trashMessage } from '../gmail/client.js';

export const trashEmailParams = {
  message_id: z.string().describe('The Gmail message ID to move to trash'),
  account: z.string().optional().describe('Account alias or email address. Uses default account if not specified.'),
};

export function registerTrashEmail(server: McpServer): void {
  server.tool(
    'trash_email',
    'Move an email to the trash. Returns success status and message ID.',
    trashEmailParams,
    async ({ message_id, account }) => {
      try {
        const result = await trashMessage({
          messageId: message_id,
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
