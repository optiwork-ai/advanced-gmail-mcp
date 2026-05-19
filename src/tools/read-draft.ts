import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { readDraft } from '../gmail/client.js';

export const readDraftParams = {
  draft_id: z.string().describe('The Gmail draft ID to read'),
  account: z.string().optional().describe('Account alias or email address. Uses default account if not specified.'),
};

export function registerReadDraft(server: McpServer): void {
  server.tool(
    'read_draft',
    'Read a draft by its ID. Returns the full underlying message content (headers, body, attachments).',
    readDraftParams,
    async ({ draft_id, account }) => {
      try {
        const result = await readDraft({
          draftId: draft_id,
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
