import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { forwardMessage } from '../gmail/client.js';

export const forwardEmailParams = {
  message_id: z.string().describe('The Gmail message ID to forward'),
  to: z.string().describe('Recipient email address(es), comma-separated'),
  account: z.string().optional().describe('Account alias or email address. Uses default account if not specified.'),
  body: z.string().optional().describe('Optional intro message prepended to the forwarded content'),
  cc: z.string().optional().describe('CC recipients (comma-separated)'),
  bcc: z.string().optional().describe('BCC recipients (comma-separated)'),
  is_html: z.boolean().optional().describe('Whether to forward as HTML (uses the original\'s HTML body)'),
};

export function registerForwardEmail(server: McpServer): void {
  server.tool(
    'forward_email',
    'Forward an existing email to new recipients. Text/HTML body is forwarded; original attachments are NOT re-attached.',
    forwardEmailParams,
    async ({ message_id, to, account, body, cc, bcc, is_html }) => {
      try {
        const result = await forwardMessage({
          messageId: message_id,
          to,
          account: account ?? undefined,
          body: body ?? undefined,
          cc: cc ?? undefined,
          bcc: bcc ?? undefined,
          is_html: is_html ?? undefined,
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
