import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { updateLabel } from '../gmail/client.js';

export const updateLabelParams = {
  label_id: z.string().describe('The label ID to update (from get_labels)'),
  account: z.string().optional().describe('Account alias or email address. Uses default account if not specified.'),
  name: z.string().optional().describe('New name for the label (omit to keep existing name)'),
  text_color: z.string().optional().describe('Hex color for label text (omit to keep existing)'),
  background_color: z.string().optional().describe('Hex color for label background (omit to keep existing)'),
};

export function registerUpdateLabel(server: McpServer): void {
  server.tool(
    'update_label',
    'Update an existing Gmail label (rename and/or recolor). At least one of name/text_color/background_color must be provided.',
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
