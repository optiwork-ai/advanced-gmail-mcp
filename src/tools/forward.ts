import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { forwardMessage } from '../gmail/client.js';
import {
  BODY_DESCRIPTION,
  GMAIL_NATIVE_CLAUSE,
  IS_HTML_DESCRIPTION,
  includeAttachmentsParam,
  includeSignatureParam,
} from './shared-params.js';

export const forwardEmailParams = {
  message_id: z.string().describe('The Gmail message ID to forward'),
  to: z.string().describe('Recipient email address(es), comma-separated'),
  account: z.string().optional().describe('Account alias or email address. Uses default account if not specified.'),
  body: z.string().optional().describe(`Optional intro message, placed above the forwarded content. ${BODY_DESCRIPTION}`),
  cc: z.string().optional().describe('CC recipients (comma-separated)'),
  bcc: z.string().optional().describe('BCC recipients (comma-separated)'),
  is_html: z.boolean().optional().describe(IS_HTML_DESCRIPTION),
  include_signature: includeSignatureParam,
  include_attachments: includeAttachmentsParam,
};

export function registerForwardEmail(server: McpServer): void {
  server.tool(
    'forward_email',
    "Forward an existing email to new recipients, re-attaching the original's attachments. "
    + GMAIL_NATIVE_CLAUSE,
    forwardEmailParams,
    async ({ message_id, to, account, body, cc, bcc, is_html, include_signature, include_attachments }) => {
      try {
        const result = await forwardMessage({
          messageId: message_id,
          to,
          account: account ?? undefined,
          body: body ?? undefined,
          cc: cc ?? undefined,
          bcc: bcc ?? undefined,
          is_html: is_html ?? undefined,
          include_signature: include_signature ?? undefined,
          include_attachments: include_attachments ?? undefined,
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
