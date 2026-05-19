import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getAttachment } from '../gmail/client.js';

export const getAttachmentParams = {
  message_id: z.string().describe('The Gmail message ID the attachment belongs to'),
  attachment_id: z.string().describe('The attachmentId from read_email\'s attachments[].attachmentId'),
  account: z.string().optional().describe('Account alias or email address. Uses default account if not specified.'),
};

export function registerGetAttachment(server: McpServer): void {
  server.tool(
    'get_attachment',
    'Fetch the bytes of an attachment. Returns size and base64-encoded data. Use read_email first to get the attachmentId from attachments[].',
    getAttachmentParams,
    async ({ message_id, attachment_id, account }) => {
      try {
        const result = await getAttachment({
          messageId: message_id,
          attachmentId: attachment_id,
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
