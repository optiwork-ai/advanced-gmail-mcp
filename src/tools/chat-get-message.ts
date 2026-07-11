import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getChatClient } from '../chat/client.js';
import { withRetry } from '../gmail/client.js';

export const getChatMessageParams = {
  name: z.string().describe('The full Chat message resource name to read, e.g. "spaces/AAAA.../messages/BBBB...".'),
  account: z.string().optional().describe('Account alias or email address. Uses default account if not specified.'),
};

/**
 * READ-ONLY: get a single Chat message by resource name.
 */
export function registerGetChatMessage(server: McpServer): void {
  server.tool(
    'get_chat_message',
    'Read a single Google Chat message by its resource name ("spaces/.../messages/..."). Read-only. Returns the full message including sender, createTime, text, and attachments metadata.',
    getChatMessageParams,
    async ({ name, account }) => {
      try {
        const chat = await getChatClient(account ?? undefined);

        const response = await withRetry(() =>
          chat.spaces.messages.get({ name })
        );

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(response.data, null, 2),
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
