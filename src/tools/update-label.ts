import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { updateLabel } from '../gmail/client.js';

export const updateLabelParams = {
  label_id: z.string().describe('The label ID to update (from get_labels)'),
  account: z.string().optional().describe('Account alias or email address. Uses default account if not specified.'),
  name: z.string().optional().describe('New name for the label (omit to keep existing name)'),
  text_color: z.string().optional().describe('Hex color for label text (omit to keep the existing one — the other half of the pair is fetched and preserved)'),
  background_color: z.string().optional().describe('Hex color for label background (omit to keep the existing one — the other half of the pair is fetched and preserved)'),
};

export function registerUpdateLabel(server: McpServer): void {
  server.tool(
    'update_label',
    'Update an existing Gmail label (rename and/or recolor). At least one of '
    + 'name/text_color/background_color must be provided — a call with none of them is refused '
    + 'rather than reported as a successful no-op. Supplying only one colour keeps the other: '
    + 'the label\'s current colour is read first and the untouched half is preserved.',
    updateLabelParams,
    async ({ label_id, account, name, text_color, background_color }) => {
      try {
        const result = await updateLabel({
          labelId: label_id,
          account: account ?? undefined,
          name: name ?? undefined,
          textColor: text_color ?? undefined,
          backgroundColor: background_color ?? undefined,
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
