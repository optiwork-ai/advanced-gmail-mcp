import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { batchModify, trashMessage } from '../gmail/client.js';

export const batchModifyParams = {
  message_ids: z.array(z.string()).describe('Array of Gmail message IDs to modify'),
  action: z.enum(['archive', 'trash', 'label']).describe('Action to perform: archive (remove INBOX), trash, or label (add/remove labels)'),
  add_labels: z.array(z.string()).optional().describe('Label IDs to add (used with "label" action)'),
  remove_labels: z.array(z.string()).optional().describe('Label IDs to remove (used with "label" action)'),
  account: z.string().optional().describe('Account alias or email address. Uses default account if not specified.'),
};

export function registerBatchModify(server: McpServer): void {
  server.tool(
    'batch_modify',
    'Batch modify multiple emails: archive, trash, or add/remove labels. Returns success status, modified count, and message IDs.',
    batchModifyParams,
    async ({ message_ids, action, add_labels, remove_labels, account }) => {
      try {
        let result: { success: boolean; modified_count: number; message_ids: string[] };

        if (action === 'archive') {
          // Archive = batch remove INBOX label
          await batchModify({
            messageIds: message_ids,
            removeLabelIds: ['INBOX'],
            account: account ?? undefined,
          });
          result = { success: true, modified_count: message_ids.length, message_ids };

        } else if (action === 'trash') {
          // Gmail API doesn't have batch trash, so trash individually
          for (const id of message_ids) {
            await trashMessage({
              messageId: id,
              account: account ?? undefined,
            });
          }
          result = { success: true, modified_count: message_ids.length, message_ids };

        } else {
          // label action: use batchModify with add/remove labels
          await batchModify({
            messageIds: message_ids,
            addLabelIds: add_labels ?? undefined,
            removeLabelIds: remove_labels ?? undefined,
            account: account ?? undefined,
          });
          result = { success: true, modified_count: message_ids.length, message_ids };
        }

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
