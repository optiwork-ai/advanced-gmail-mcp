import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { chat_v1 } from 'googleapis';
import { CHAT_SPACES_SCOPE, getChatClient } from '../chat/client.js';
import { resolveAccount } from '../config.js';
import { googleApiCall } from '../google-api-error.js';

/**
 * The four fields the tool description promises — and now the four it returns.
 *
 * The raw Space object carries a dozen more (spaceUri, spaceHistoryState,
 * adminInstalled, the deprecated `type`, …). None of them was asked for, and
 * every listing was paying for all of them in the conversation's memory while
 * the description named four. Projecting makes the call cheaper and stops the
 * tool describing itself wrongly.
 *
 * A field that is absent is left out rather than emitted as null: `null`
 * asserts "this space has no display name", when the truth is that Google did
 * not send one.
 *
 * Exported for unit testing.
 */
export function projectSpace(space: chat_v1.Schema$Space): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (space.name != null) out.name = space.name;
  if (space.displayName != null) out.displayName = space.displayName;
  if (space.spaceType != null) out.spaceType = space.spaceType;
  if (space.spaceDetails != null) out.spaceDetails = space.spaceDetails;
  return out;
}

export const listChatSpacesParams = {
  account: z.string().optional().describe('Account alias or email address. Uses default account if not specified.'),
  filter: z.string().optional().describe('Optional Chat API filter, e.g. \'spaceType = "SPACE"\' or \'spaceType = "DIRECT_MESSAGE"\'.'),
  max_results: z.number().optional().describe('Maximum number of spaces to return (default: 500, max: 1000). Paginates automatically.'),
};

/**
 * READ-ONLY: list the Chat spaces the account is a member of.
 */
export function registerListChatSpaces(server: McpServer): void {
  server.tool(
    'list_chat_spaces',
    'List the Google Chat spaces (rooms and direct messages) the account is a member of. Read-only. Returns name, displayName, spaceType, and spaceDetails.',
    listChatSpacesParams,
    async ({ account, filter, max_results }) => {
      try {
        const resolved = resolveAccount(account ?? undefined);
        const chat = await getChatClient(resolved);
        const ctx = { tool: 'list_chat_spaces', api: 'Google Chat', scope: CHAT_SPACES_SCOPE, alias: resolved.alias };
        const maxResults = Math.min(max_results ?? 500, 1000);

        const spaces: chat_v1.Schema$Space[] = [];
        let pageToken: string | undefined;

        while (spaces.length < maxResults) {
          const pageSize = Math.min(maxResults - spaces.length, 1000);
          const response = await googleApiCall(ctx, () =>
            chat.spaces.list({
              pageSize,
              pageToken,
              filter: filter || undefined,
            })
          );

          const page = response.data.spaces || [];
          spaces.push(...page);

          pageToken = response.data.nextPageToken ?? undefined;
          if (!pageToken || page.length === 0) break;
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(spaces.slice(0, maxResults).map(projectSpace), null, 2),
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
