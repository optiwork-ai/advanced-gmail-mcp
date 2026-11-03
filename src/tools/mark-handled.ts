import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { markHandled } from '../gmail/client.js';

export const markHandledParams = {
  message_id: z.string().optional().describe('A message in the conversation to file. Give this or thread_id, not both.'),
  thread_id: z.string().optional().describe('The conversation (thread) to file. Give this or message_id, not both.'),
  account: z.string().optional().describe('Account alias or email address. Uses default account if not specified.'),
};

export function registerMarkHandled(server: McpServer): void {
  server.tool(
    'mark_handled',
    'File an email you have handled: marks its whole conversation read, takes it out of the inbox and '
    + 'labels it "Handled by Claude" (the label is created the first time an account needs it). '
    + 'reply_email, forward_email and send_draft of a reply already do this by themselves. '
    + 'Use this when you finished what the email asked WITHOUT replying (for example you did the task, '
    + 'or the owner said it needs no answer). Do NOT use it when you only read the email or looked '
    + 'something up in it; leave that email as it was so the owner still sees it.',
    markHandledParams,
    async ({ message_id, thread_id, account }) => {
      try {
        const result = await markHandled({
          messageId: message_id ?? undefined,
          threadId: thread_id ?? undefined,
          account: account ?? undefined,
        });

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
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
