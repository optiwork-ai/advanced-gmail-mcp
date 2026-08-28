import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { deleteLabel } from '../gmail/client.js';

export const deleteLabelParams = {
  label_id: z.string().describe('The label ID to delete (from get_labels)'),
  confirm: z.boolean().optional().describe('Required to be true. The call is REFUSED without it. Pass it only after the user has explicitly asked for this label to be deleted — never to clear the refusal.'),
  account: z.string().optional().describe('Account alias or email address. Uses default account if not specified.'),
};

export function registerDeleteLabel(server: McpServer): void {
  server.tool(
    'delete_label',
    'Delete a Gmail label. The label is removed from every message it was applied to (the messages themselves are not deleted), and there is NO UNDO — the labelling work is gone. '
    + 'This is enforced, not advisory: the call is refused unless confirm: true is passed, and you may pass it only after the user has explicitly asked for this label to be deleted.',
    deleteLabelParams,
    async ({ label_id, confirm, account }) => {
      try {
        const result = await deleteLabel({
          labelId: label_id,
          confirm: confirm ?? undefined,
          account: account ?? undefined,
        });

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
