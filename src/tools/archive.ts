import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { modifyMessage } from '../gmail/client.js';

export const archiveEmailParams = {
  message_id: z.string().describe('The Gmail message ID to archive'),
  account: z.string().optional().describe('Account alias or email address. Uses default account if not specified.'),
};

export function registerArchiveEmail(server: McpServer): void {
  server.tool(
    'archive_email',
    'Archive an email by removing the INBOX label. Returns success status and message ID.',
    archiveEmailParams,
    async ({ message_id, account }) => {
      try {
        const result = await modifyMessage({
          messageId: message_id,
          removeLabelIds: ['INBOX'],
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
    },
  );
}
