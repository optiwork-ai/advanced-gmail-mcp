import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createLabel } from '../gmail/client.js';

export const createLabelParams = {
  name: z.string().describe('Label name. Use "/" to nest (e.g. "Receipts/2026")'),
  account: z.string().optional().describe('Account alias or email address. Uses default account if not specified.'),
  text_color: z.string().optional().describe('Hex color for label text (e.g. "#ffffff"). Must be one of Gmail\'s allowed palette values.'),
  background_color: z.string().optional().describe('Hex color for label background. Must be one of Gmail\'s allowed palette values.'),
};

export function registerCreateLabel(server: McpServer): void {
  server.tool(
    'create_label',
    'Create a new Gmail label. Returns the new label\'s id and name. Use "/" in the name to nest labels.',
    createLabelParams,
    async ({ name, account, text_color, background_color }) => {
      try {
        const result = await createLabel({
          name,
          account: account ?? undefined,
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
