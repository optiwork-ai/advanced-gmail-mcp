import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { batchModify, batchTrash } from '../gmail/client.js';

export const batchModifyParams = {
  message_ids: z.array(z.string()).describe('Array of Gmail message IDs to modify'),
  action: z.enum(['archive', 'trash', 'label']).describe('Action to perform: archive (remove INBOX), trash, or label (add/remove labels)'),
  add_labels: z.array(z.string()).optional().describe('Label IDs to add (required, with or instead of remove_labels, for the "label" action)'),
  remove_labels: z.array(z.string()).optional().describe('Label IDs to remove (required, with or instead of add_labels, for the "label" action)'),
  account: z.string().optional().describe('Account alias or email address. Uses default account if not specified.'),
};

export function registerBatchModify(server: McpServer): void {
  server.tool(
    'batch_modify',
    'Batch modify many messages at once: archive (remove INBOX), trash, or add/remove labels. '
    + 'Returns { success, modified_count, message_ids } where message_ids are the ones that '
    + 'actually succeeded, plus a failures list when some did not — a partial failure is '
    + 'reported, never swallowed. Archive and label are chunked at Gmail\'s 1000-id limit; '
    + 'Gmail has no batch trash, so trash is one call per message run 10 at a time and '
    + 'continues past a failure. Note that Gmail returns no per-message outcome for the '
    + 'archive/label path, so a chunk that the API accepts is counted as modified.',
    batchModifyParams,
    async ({ message_ids, action, add_labels, remove_labels, account }) => {
      try {
        // The client's own result is returned as-is. The old code rebuilt
        // { success: true, ... } from the input array three separate times, so a
        // Gmail response indicating fewer modifications could never surface.
        const result = action === 'archive'
          ? await batchModify({
              messageIds: message_ids,
              removeLabelIds: ['INBOX'],
              account: account ?? undefined,
            })
          : action === 'trash'
            ? await batchTrash({
                messageIds: message_ids,
                account: account ?? undefined,
              })
            : await batchModify({
                messageIds: message_ids,
                addLabelIds: add_labels ?? undefined,
                removeLabelIds: remove_labels ?? undefined,
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
