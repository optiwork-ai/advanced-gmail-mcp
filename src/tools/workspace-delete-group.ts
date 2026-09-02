import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  ADMIN_DIRECTORY_GROUP_SCOPE,
  ADMIN_SDK_API,
  adminCreateCall,
  getDirectoryClient,
  requireAdminAccount,
} from '../workspace-admin/client.js';
import { log } from '../log.js';
import { adminAccountParam } from './shared-params.js';

/**
 * WA8 — delete a group, which is to say switch an address off.
 *
 * Gated the way delete_label is, and for a bigger reason: a deleted label loses
 * some filing, a deleted group means every message anyone sends to that address
 * bounces back to them from that moment on, including messages from customers
 * who have no way of knowing the address changed.
 */
export const deleteGroupParams = {
  account: adminAccountParam,
  group_key: z.string().describe("The group's email address, an alias, or its Directory id."),
  confirm: z.boolean().optional().describe('Required to be true. The call is REFUSED without it. Pass it only after the user has explicitly asked for this address to be deleted — never to clear the refusal.'),
};

export function registerDeleteGroup(server: McpServer): void {
  server.tool(
    'delete_group',
    'Delete a Google Group in the Workspace that the given account administers. WRITES, and '
    + 'destructively: from that moment on, every message sent to the address BOUNCES back to '
    + 'whoever sent it, including customers who have no way of knowing the address changed. '
    + 'The group\'s archived conversations and membership go with it. There is NO UNDO — '
    + 'recreating the address later does not bring any of it back. '
    + 'This is enforced, not advisory: the call is refused unless confirm: true is passed, and '
    + 'you may pass it only after the user has explicitly asked for this address to be deleted. '
    + 'To stop an address receiving mail without destroying it, consider update_group_settings '
    + 'instead.',
    deleteGroupParams,
    async ({ account, group_key, confirm }) => {
      try {
        const resolved = requireAdminAccount(account);
        const groupKey = (group_key ?? '').trim();
        if (!groupKey) throw new Error('delete_group: group_key is required.');

        if (confirm !== true) {
          throw new Error(
            `delete_group: refused. Deleting "${groupKey}" makes every message sent to that `
            + 'address bounce from then on, and there is no undo. Pass confirm: true only after '
            + 'the user has explicitly asked for this address to be deleted.',
          );
        }

        const directory = await getDirectoryClient(resolved);
        log('info', 'delete_group', { account: resolved.alias, group: groupKey, phase: 'start' });

        await adminCreateCall(
          {
            tool: 'delete_group',
            api: ADMIN_SDK_API,
            scope: ADMIN_DIRECTORY_GROUP_SCOPE,
            alias: resolved.alias,
            target: 'group',
            key: groupKey,
          },
          { what: `the group ${groupKey}`, check: 'get_group' },
          () => directory.groups.delete({ groupKey }),
        );

        log('info', 'delete_group', { account: resolved.alias, group: groupKey, phase: 'done' });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              account: resolved.alias,
              deleted: groupKey,
              note: `Mail sent to ${groupKey} will now bounce. This cannot be undone.`,
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
