import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { modifyMessage } from '../gmail/client.js';

const params = {
  message_id: z.string().describe('The Gmail message ID'),
  account: z.string().optional().describe('Account alias or email address. Uses default account if not specified.'),
};

function makeHandler(label: 'STARRED' | 'IMPORTANT', op: 'add' | 'remove') {
  return async ({ message_id, account }: { message_id: string; account?: string | undefined }) => {
    try {
      const result = await modifyMessage({
        messageId: message_id,
        addLabelIds: op === 'add' ? [label] : undefined,
        removeLabelIds: op === 'remove' ? [label] : undefined,
        account: account ?? undefined,
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ success: result.success, id: result.id }, null, 2),
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
  };
}

export function registerStarTools(server: McpServer): void {
  server.tool('star_email', 'Star an email (add STARRED label).', params, makeHandler('STARRED', 'add'));
  server.tool('unstar_email', 'Unstar an email (remove STARRED label).', params, makeHandler('STARRED', 'remove'));
  server.tool('mark_important', 'Mark an email as important (add IMPORTANT label).', params, makeHandler('IMPORTANT', 'add'));
  server.tool('mark_not_important', 'Mark an email as not important (remove IMPORTANT label).', params, makeHandler('IMPORTANT', 'remove'));
}
