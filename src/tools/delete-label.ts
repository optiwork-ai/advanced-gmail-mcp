import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { deleteLabel } from '../gmail/client.js';

export const deleteLabelParams = {
  label_id: z.string().describe('The label ID to delete (from get_labels)'),
  account: z.string().optional().describe('Account alias or email address. Uses default account if not specified.'),
};

export function registerDeleteLabel(server: McpServer): void {
  server.tool(
    'delete_label',
    'Delete a Gmail label. The label is removed from every message it was applied to (the messages themselves are not deleted). Confirm with the user first — there is no undo.',
    deleteLabelParams,
    async ({ label_id, account }) => {
      try {
        const result = await deleteLabel({
          labelId: label_id,
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
