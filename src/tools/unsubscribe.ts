import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { unsubscribeFromEmail } from '../gmail/client.js';

export const unsubscribeParams = {
  message_id: z.string().describe('The Gmail message ID to unsubscribe from'),
  confirm: z.boolean().optional().describe('Required to be true ONLY when the list has no working one-click link and unsubscribing therefore means sending an email from this account. Call once without it: if a send is needed, the result names the exact recipient, subject and body, and nothing is sent. Pass confirm: true only after the user has agreed to that send — never to clear the refusal.'),
  account: z.string().optional().describe('Account alias or email address. Uses default account if not specified.'),
};

export function registerUnsubscribe(server: McpServer): void {
  server.tool(
    'unsubscribe_email',
    'Unsubscribe from a mailing list by processing the email\'s List-Unsubscribe header. '
    + 'The preferred path is a one-click HTTPS request, which sends no mail and needs no confirmation. '
    + 'When the list offers no working one-click link, the only way to unsubscribe is to SEND AN EMAIL from this account to the list — that send requires confirm: true, and without it the call is refused and tells you exactly what it would have sent. '
    + 'An email that simply has no List-Unsubscribe header is a success with nothing to do, not a failure: do not retry it. '
    + 'Returns the method used (https, mailto, or none) and a plain-language detail.',
    unsubscribeParams,
    async ({ message_id, confirm, account }) => {
      try {
        const result = await unsubscribeFromEmail({
          messageId: message_id,
          confirm: confirm ?? undefined,
          account: account ?? undefined,
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
          isError: !result.success,
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
