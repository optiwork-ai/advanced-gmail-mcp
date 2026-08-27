import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { deleteDraft } from '../gmail/client.js';

export const deleteDraftParams = {
  draft_id: z.string().describe('The draft ID to delete (from draft_email, draft_reply or list_drafts)'),
  account: z.string().optional().describe('Account alias or email address. Uses default account if not specified.'),
};

export function registerDeleteDraft(server: McpServer): void {
  server.tool(
    'delete_draft',
    'Permanently delete a draft. This is NOT a move to trash — the draft is gone and there is no '
    + 'undo. Confirm with the user first. Returns success and the draft id.',
    deleteDraftParams,
    async ({ draft_id, account }) => {
      try {
        const result = await deleteDraft({
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
