import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { sendDraft } from '../gmail/client.js';

export const sendDraftParams = {
  draft_id: z.string().describe('The Gmail draft ID to send (returned by draft_email or draft_reply)'),
  account: z.string().optional().describe('Account alias (vyg, indigo, personal, abacus) or email. Defaults to personal.'),
};

export function registerSendDraft(server: McpServer): void {
  server.tool(
    'send_draft',
    'Send an existing draft by its draft ID. Use after reviewing a draft created by draft_email or draft_reply.',
    sendDraftParams,
    async ({ draft_id, account }) => {
      try {
        const result = await sendDraft({
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
