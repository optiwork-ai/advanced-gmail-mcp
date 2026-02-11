import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getThread } from '../gmail/client.js';

export const getThreadParams = {
  thread_id: z.string().describe('The Gmail thread ID to retrieve'),
  account: z.string().optional().describe('Account alias or email address. Uses default account if not specified.'),
};

export function registerGetThread(server: McpServer): void {
  server.tool(
    'get_thread',
    'Get a full email thread by thread ID. Returns all messages in the thread with from, subject, date, body, and labels.',
    getThreadParams,
    async ({ thread_id, account }) => {
      try {
        const result = await getThread({
          threadId: thread_id,
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
