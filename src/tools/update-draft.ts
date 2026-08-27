import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { updateDraft } from '../gmail/client.js';
import {
  BODY_DESCRIPTION,
  GMAIL_NATIVE_CLAUSE,
  IS_HTML_DESCRIPTION,
  attachmentsParam,
  includeSignatureParam,
  inlineImagesParam,
} from './shared-params.js';

export const updateDraftParams = {
  draft_id: z.string().describe('The draft ID to replace (from draft_email, draft_reply or list_drafts)'),
  to: z.string().describe('Recipient email address'),
  subject: z.string().describe('Email subject line'),
  body: z.string().describe(BODY_DESCRIPTION),
  account: z.string().optional().describe('Account alias or email address. Uses default account if not specified.'),
  cc: z.string().optional().describe('CC recipients (comma-separated)'),
  bcc: z.string().optional().describe('BCC recipients (comma-separated)'),
  is_html: z.boolean().optional().describe(IS_HTML_DESCRIPTION),
  include_signature: includeSignatureParam,
  attachments: attachmentsParam,
  inline_images: inlineImagesParam,
};

export function registerUpdateDraft(server: McpServer): void {
  server.tool(
    'update_draft',
    'Replace the contents of an existing draft. Gmail REPLACES the draft rather than patching it, '
    + 'so every field must be supplied again — read_draft first if you are editing rather than '
    + 'rewriting, or anything you omit is lost. The draft keeps its id and stays attached to its '
    + `thread. Returns the draft id and message info. ${GMAIL_NATIVE_CLAUSE}`,
    updateDraftParams,
    async ({ draft_id, to, subject, body, account, cc, bcc, is_html, include_signature, attachments, inline_images }) => {
      try {
        const result = await updateDraft({
          draftId: draft_id,
          to,
          subject,
          body,
          account: account ?? undefined,
          cc: cc ?? undefined,
          bcc: bcc ?? undefined,
          is_html: is_html ?? undefined,
          include_signature: include_signature ?? undefined,
          attachments: attachments ?? undefined,
          inline_images: inline_images ?? undefined,
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
