import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { listLabels } from '../gmail/client.js';

export const getLabelsParams = {
  account: z.string().optional().describe('Account alias or email address. Uses default account if not specified.'),
};

export function registerGetLabels(server: McpServer): void {
  server.tool(
    'get_labels',
    'List all Gmail labels for an account. Returns label id, name, type, and message counts (total and unread).',
    getLabelsParams,
    async ({ account }) => {
      try {
        const results = await listLabels({
          account: account ?? undefined,
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(results, null, 2),
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
