import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createDraftReply } from '../gmail/client.js';
import {
  BODY_DESCRIPTION,
  GMAIL_NATIVE_CLAUSE,
  IS_HTML_DESCRIPTION,
  attachmentsParam,
  includeQuoteParam,
  includeSignatureParam,
  inlineImagesParam,
} from './shared-params.js';

export const draftReplyParams = {
  message_id: z.string().describe('The Gmail message ID to reply to'),
  body: z.string().describe(BODY_DESCRIPTION),
  account: z.string().optional().describe('Account alias or email address. Uses default account if not specified.'),
  is_html: z.boolean().optional().describe(IS_HTML_DESCRIPTION),
  reply_all: z.boolean().optional().describe('Reply to all recipients (default: false, replies only to sender). As in Gmail, the original To recipients go in To and the original Cc in Cc, both minus your own address.'),
  cc: z.string().optional().describe('CC recipients (comma-separated). Merged with reply-all CCs if both provided.'),
  bcc: z.string().optional().describe('BCC recipients (comma-separated)'),
  include_signature: includeSignatureParam,
  include_quote: includeQuoteParam,
  attachments: attachmentsParam,
  inline_images: inlineImagesParam,
};

export function registerDraftReply(server: McpServer): void {
  server.tool(
    'draft_reply',
    'Create a draft reply to an existing email. Fetches original message for proper threading '
    + "(In-Reply-To, References, threadId) and honours the original's Reply-To. Draft appears in "
    + 'Gmail for review before sending — use send_draft to send after review. '
    + GMAIL_NATIVE_CLAUSE,
    draftReplyParams,
    async ({ message_id, body, account, is_html, reply_all, cc, bcc, include_signature, include_quote, attachments, inline_images }) => {
      try {
        const result = await createDraftReply({
          messageId: message_id,
          body,
          account: account ?? undefined,
          is_html: is_html ?? undefined,
          reply_all: reply_all ?? undefined,
          cc: cc ?? undefined,
          bcc: bcc ?? undefined,
          include_signature: include_signature ?? undefined,
          include_quote: include_quote ?? undefined,
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
