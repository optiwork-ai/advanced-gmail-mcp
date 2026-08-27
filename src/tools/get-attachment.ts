import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getAttachment } from '../gmail/client.js';

export const getAttachmentParams = {
  message_id: z.string().describe('The Gmail message ID the attachment belongs to'),
  attachment_id: z.string().describe('The attachmentId from read_email\'s attachments[].attachmentId'),
  account: z.string().optional().describe('Account alias or email address. Uses default account if not specified.'),
  save_dir: z
    .string()
    .optional()
    .describe(
      'Absolute path of an EXISTING directory to write the attachment into. '
      + 'Strongly preferred: the result is then a file path instead of base64 in the '
      + 'conversation. The filename comes from the message (sanitized); an existing '
      + 'file is never overwritten (a "-1", "-2" suffix is added instead). '
      + 'Omit only for small attachments you actually need the bytes of inline.',
    ),
};

export function registerGetAttachment(server: McpServer): void {
  server.tool(
    'get_attachment',
    'Fetch an attachment. Always returns filename, mimeType and size. With save_dir it writes the '
    + 'file to that directory and returns its path; without save_dir it returns the bytes as base64 '
    + 'in data_base64, but only for attachments up to 1MB — anything larger errors and asks for '
    + 'save_dir. Use read_email first to get the attachmentId from attachments[].',
    getAttachmentParams,
    async ({ message_id, attachment_id, account, save_dir }) => {
      try {
        const result = await getAttachment({
          messageId: message_id,
          attachmentId: attachment_id,
          account: account ?? undefined,
          saveDir: save_dir ?? undefined,
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
