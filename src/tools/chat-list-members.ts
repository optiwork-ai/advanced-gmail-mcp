import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { chat_v1 } from 'googleapis';
import { getChatClient } from '../chat/client.js';
import { withRetry } from '../gmail/client.js';

export const listChatMembersParams = {
  space: z.string().describe('The Chat space to list members of. Accepts a full resource name ("spaces/AAAA...") or a bare space id ("AAAA...").'),
  account: z.string().optional().describe('Account alias or email address. Uses default account if not specified.'),
  max_results: z.number().optional().describe('Maximum number of members to return (default: 500, max: 1000). Paginates automatically.'),
};

/**
 * Normalize a space id or full resource name into "spaces/{id}".
 */
function toSpaceParent(space: string): string {
  const trimmed = space.trim();
  return trimmed.startsWith('spaces/') ? trimmed : `spaces/${trimmed}`;
}

/**
 * READ-ONLY: list the members of a Chat space.
 */
export function registerListChatMembers(server: McpServer): void {
  server.tool(
    'list_chat_members',
    'List the members (memberships) of a Google Chat space. Read-only. Requires a space name/id. Returns membership name, state, role, and member identity.',
    listChatMembersParams,
    async ({ space, account, max_results }) => {
      try {
        const chat = await getChatClient(account ?? undefined);
        const parent = toSpaceParent(space);
        const maxResults = Math.min(max_results ?? 500, 1000);

        const memberships: chat_v1.Schema$Membership[] = [];
        let pageToken: string | undefined;

        while (memberships.length < maxResults) {
          const pageSize = Math.min(maxResults - memberships.length, 1000);
          const response = await withRetry(() =>
            chat.spaces.members.list({
              parent,
              pageSize,
              pageToken,
            })
          );

          const page = response.data.memberships || [];
          memberships.push(...page);

          pageToken = response.data.nextPageToken ?? undefined;
          if (!pageToken || page.length === 0) break;
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(memberships.slice(0, maxResults), null, 2),
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
