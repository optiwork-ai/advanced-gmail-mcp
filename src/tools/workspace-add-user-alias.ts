import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  ADMIN_DIRECTORY_USER_SCOPE,
  ADMIN_SDK_API,
  adminCreateCall,
  getDirectoryClient,
  requireAdminAccount,
} from '../workspace-admin/client.js';
import { log } from '../log.js';
import { adminAccountParam } from './shared-params.js';

/**
 * WA14 — a second address that reaches the same person.
 *
 * Rides `admin.directory.user`: Google folds user alias operations into the
 * user scope, so there is no separate alias grant to ask for. An alias costs
 * nothing — unlike a second user, which is a second paid seat.
 */
export const addUserAliasParams = {
  account: adminAccountParam,
  user_key: z.string().describe("The person's primary email address, an existing alias, or their Directory id."),
  alias: z.string().describe('The new address, on a domain of this Workspace, e.g. "emma@optiwork.ai".'),
};

export function registerAddUserAlias(server: McpServer): void {
  server.tool(
    'add_user_alias',
    'Add another address that reaches an existing person in the Google Workspace the given '
    + 'account administers. WRITES: mail sent to the new address is delivered to that person '
    + 'from then on, and they can send as it. An alias is FREE — it does not add a seat, which '
    + 'is why a second address for someone should be an alias rather than a second user. The '
    + 'alias must be on a domain of this Workspace and unused by any other user, group or alias.',
    addUserAliasParams,
    async ({ account, user_key, alias }) => {
      try {
        const resolved = requireAdminAccount(account);
        const userKey = (user_key ?? '').trim();
        const newAlias = (alias ?? '').trim();
        if (!userKey) throw new Error('add_user_alias: user_key is required.');
        if (!newAlias) throw new Error('add_user_alias: alias is required.');

        const directory = await getDirectoryClient(resolved);
        log('info', 'add_user_alias', { account: resolved.alias, user: userKey, alias: newAlias, phase: 'start' });

        const added = await adminCreateCall(
          {
            tool: 'add_user_alias',
            api: ADMIN_SDK_API,
            scope: ADMIN_DIRECTORY_USER_SCOPE,
            alias: resolved.alias,
            target: 'user alias',
            key: newAlias,
          },
          { what: `the alias ${newAlias}`, check: 'get_workspace_user' },
          () => directory.users.aliases.insert({ userKey, requestBody: { alias: newAlias } }),
        );

        log('info', 'add_user_alias', { account: resolved.alias, user: userKey, alias: newAlias, phase: 'done' });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              account: resolved.alias,
              user: userKey,
              alias: added.data.alias ?? newAlias,
            }, null, 2),
          }],
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
