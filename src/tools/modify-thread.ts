import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { modifyThread } from '../gmail/client.js';

export const modifyThreadParams = {
  thread_id: z.string().describe('The Gmail thread ID to modify (from list_emails/read_email threadId, or get_thread)'),
  add_labels: z.array(z.string()).optional().describe('Label IDs to add to every message in the thread'),
  remove_labels: z.array(z.string()).optional().describe('Label IDs to remove from every message in the thread. To archive the whole conversation, remove "INBOX".'),
  account: z.string().optional().describe('Account alias or email address. Uses default account if not specified.'),
};

export function registerModifyThread(server: McpServer): void {
  server.tool(
    'modify_thread',
    'Add and/or remove labels on EVERY message in a thread. This is the thread-level counterpart '
    + 'of label_email and archive_email — archiving a single message leaves the rest of the '
    + 'conversation in the inbox, so prefer this when the user means "the conversation". '
    + 'Archive the thread by passing remove_labels: ["INBOX"]. Labels are IDs, not names '
    + '(get_labels). At least one of add_labels/remove_labels is required. '
    + 'Returns success, the thread id, and the union of the labels now on its messages.',
    modifyThreadParams,
    async ({ thread_id, add_labels, remove_labels, account }) => {
      try {
        const result = await modifyThread({
          threadId: thread_id,
          addLabelIds: add_labels ?? undefined,
          removeLabelIds: remove_labels ?? undefined,
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
