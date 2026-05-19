import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { unsubscribeFromEmail } from '../gmail/client.js';

export const unsubscribeParams = {
  message_id: z.string().describe('The Gmail message ID to unsubscribe from'),
  account: z.string().optional().describe('Account alias or email address. Uses default account if not specified.'),
};

export function registerUnsubscribe(server: McpServer): void {
  server.tool(
    'unsubscribe_email',
    'Unsubscribe from a mailing list. Reads the List-Unsubscribe header and processes it (mailto or one-click HTTPS). Returns success/failure and method used.',
    unsubscribeParams,
    async ({ message_id, account }) => {
      try {
        const result = await unsubscribeFromEmail({
          messageId: message_id,
          account: account ?? undefined,
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
          isError: !result.success,
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
