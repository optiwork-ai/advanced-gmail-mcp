import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  ADMIN_DIRECTORY_GROUP_SCOPE,
  ADMIN_SDK_API,
  adminCall,
  getDirectoryClient,
  requireAdminAccount,
} from '../workspace-admin/client.js';
import { log } from '../log.js';
import { adminAccountParam } from './shared-params.js';

/**
 * WA9 — a second address that reaches the same group.
 *
 * Rides `admin.directory.group`: Google folds group alias operations into the
 * group scope, so there is no separate alias grant to ask for.
 */
export const addGroupAliasParams = {
  account: adminAccountParam,
  group_key: z.string().describe("The group's email address, an existing alias, or its Directory id."),
  alias: z.string().describe('The new address, on a domain of this Workspace, e.g. "orders@optiwork.ai".'),
};

export function registerAddGroupAlias(server: McpServer): void {
  server.tool(
    'add_group_alias',
    'Add another address that reaches an existing Google Group in the Workspace the given '
    + 'account administers. WRITES: mail sent to the new address is delivered to the group from '
    + 'then on, and the group can send as it. The alias must be on a domain of this Workspace, '
    + 'and no other user, group or alias may already be using it.',
    addGroupAliasParams,
    async ({ account, group_key, alias }) => {
      try {
        const resolved = requireAdminAccount(account);
        const groupKey = (group_key ?? '').trim();
        const newAlias = (alias ?? '').trim();
        if (!groupKey) throw new Error('add_group_alias: group_key is required.');
        if (!newAlias) throw new Error('add_group_alias: alias is required.');

        const directory = await getDirectoryClient(resolved);
        log('info', 'add_group_alias', { account: resolved.alias, group: groupKey, alias: newAlias, phase: 'start' });

        const added = await adminCall(
          {
            tool: 'add_group_alias',
            api: ADMIN_SDK_API,
            scope: ADMIN_DIRECTORY_GROUP_SCOPE,
            alias: resolved.alias,
            target: 'group alias',
            key: newAlias,
          },
          // Retried on a server error, unlike the creates and deletes here: an
          // alias insert that quietly landed and is sent again is answered
          // "already exists" rather than making a second one, so a retry after
          // a timeout costs nothing and saves a call that would otherwise be
          // reported as failed when it worked.
          () => directory.groups.aliases.insert({ groupKey, requestBody: { alias: newAlias } }),
        );

        log('info', 'add_group_alias', { account: resolved.alias, group: groupKey, alias: newAlias, phase: 'done' });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              account: resolved.alias,
              group: groupKey,
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
