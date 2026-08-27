import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getMessage } from '../gmail/client.js';

export const readEmailParams = {
  message_id: z.string().describe('The Gmail message ID to read'),
  account: z.string().optional().describe('Account alias or email address. Uses default account if not specified.'),
  format: z.enum(['full', 'metadata', 'minimal']).optional().describe('full (default) returns the body, attachments and every header. metadata returns headers only, minimal returns only ids/labels/snippet — both of those return a body_note instead of a body, never an empty body.'),
};

export function registerReadEmail(server: McpServer): void {
  server.tool(
    'read_email',
    'Read a single email by message ID. With the default format "full" it returns the body '
    + '(text and HTML), headers, labels and attachment metadata. With format "metadata" or '
    + '"minimal" it returns a headers-only shape with an explicit body_note saying no body was '
    + 'requested — those formats never return a body.',
    readEmailParams,
    async ({ message_id, account, format }) => {
      try {
        const result = await getMessage({
          messageId: message_id,
          account: account ?? undefined,
          format: (format as 'full' | 'metadata' | 'minimal') ?? undefined,
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
