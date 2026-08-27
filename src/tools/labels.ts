import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { listLabels } from '../gmail/client.js';

export const getLabelsParams = {
  account: z.string().optional().describe('Account alias or email address. Uses default account if not specified.'),
  include_counts: z
    .boolean()
    .optional()
    .describe(
      'Also return messagesTotal and messagesUnread for every label (default: false). '
      + 'This costs one extra API call PER label, so ask for it only when the counts are '
      + 'actually the point.',
    ),
};

export function registerGetLabels(server: McpServer): void {
  server.tool(
    'get_labels',
    'List all Gmail labels for an account. Returns label id, name, type and (where the label has '
    + 'one) its colours. Message counts are NOT included by default — Gmail\'s label listing does '
    + 'not carry them; pass include_counts: true to fetch messagesTotal/messagesUnread per label.',
    getLabelsParams,
    async ({ account, include_counts }) => {
      try {
        const results = await listLabels({
          account: account ?? undefined,
          includeCounts: include_counts ?? undefined,
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
