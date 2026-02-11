import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { modifyMessage } from '../gmail/client.js';

export const labelEmailParams = {
  message_id: z.string().describe('The Gmail message ID to modify labels on'),
  add_labels: z.array(z.string()).optional().describe('Label IDs to add to the message'),
  remove_labels: z.array(z.string()).optional().describe('Label IDs to remove from the message'),
  account: z.string().optional().describe('Account alias or email address. Uses default account if not specified.'),
};

export function registerLabelEmail(server: McpServer): void {
  server.tool(
    'label_email',
    'Add or remove labels on an email. Returns success status, message ID, and current labels.',
    labelEmailParams,
    async ({ message_id, add_labels, remove_labels, account }) => {
      try {
        const result = await modifyMessage({
          messageId: message_id,
          addLabelIds: add_labels ?? undefined,
          removeLabelIds: remove_labels ?? undefined,
          account: account ?? undefined,
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ success: result.success, id: result.id, labels: result.labels }, null, 2),
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
