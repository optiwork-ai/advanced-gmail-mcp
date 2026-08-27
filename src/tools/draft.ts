import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createDraft } from '../gmail/client.js';
import {
  BODY_DESCRIPTION,
  GMAIL_NATIVE_CLAUSE,
  IS_HTML_DESCRIPTION,
  attachmentsParam,
  includeSignatureParam,
} from './shared-params.js';

export const draftEmailParams = {
  to: z.string().describe('Recipient email address'),
  subject: z.string().describe('Email subject line'),
  body: z.string().describe(BODY_DESCRIPTION),
  account: z.string().optional().describe('Account alias or email address. Uses default account if not specified.'),
  cc: z.string().optional().describe('CC recipients (comma-separated)'),
  bcc: z.string().optional().describe('BCC recipients (comma-separated)'),
  is_html: z.boolean().optional().describe(IS_HTML_DESCRIPTION),
  include_signature: includeSignatureParam,
  attachments: attachmentsParam,
};

export function registerDraftEmail(server: McpServer): void {
  server.tool(
    'draft_email',
    `Create a draft email. Returns the draft ID and message info. ${GMAIL_NATIVE_CLAUSE}`,
    draftEmailParams,
    async ({ to, subject, body, account, cc, bcc, is_html, include_signature, attachments }) => {
      try {
        const result = await createDraft({
          to,
          subject,
          body,
          account: account ?? undefined,
          cc: cc ?? undefined,
          bcc: bcc ?? undefined,
          is_html: is_html ?? undefined,
          include_signature: include_signature ?? undefined,
          attachments: attachments ?? undefined,
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
