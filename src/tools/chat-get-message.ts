import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CHAT_MESSAGES_SCOPE, getChatClient } from '../chat/client.js';
import { toMessageName } from '../chat/names.js';
import { resolveAccount } from '../config.js';
import { googleApiCall } from '../google-api-error.js';

export const getChatMessageParams = {
  name: z.string().describe('The Chat message resource name to read, e.g. "spaces/AAAA.../messages/BBBB...". The leading "spaces/" may be omitted, exactly as list_chat_messages allows for its space argument.'),
  account: z.string().optional().describe('Account alias or email address. Uses default account if not specified.'),
};

/**
 * READ-ONLY: get a single Chat message by resource name.
 */
export function registerGetChatMessage(server: McpServer): void {
  server.tool(
    'get_chat_message',
    'Read a single Google Chat message by its resource name ("spaces/.../messages/...", with the leading "spaces/" optional). Read-only. Returns the full message including sender, createTime, text, and attachments metadata. Take the name from list_chat_messages: a bare message id is not enough, because a message is identified by its space too.',
    getChatMessageParams,
    async ({ name, account }) => {
      try {
        const resolved = resolveAccount(account ?? undefined);
        const chat = await getChatClient(resolved);
        const ctx = { tool: 'get_chat_message', api: 'Google Chat', scope: CHAT_MESSAGES_SCOPE, alias: resolved.alias };

        const response = await googleApiCall(ctx, () =>
          chat.spaces.messages.get({ name: toMessageName(name) })
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
