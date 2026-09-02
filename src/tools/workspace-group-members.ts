import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  ADMIN_DIRECTORY_GROUP_MEMBER_SCOPE,
  ADMIN_SDK_API,
  adminCreateCall,
  getDirectoryClient,
  projectMember,
  requireAdminAccount,
} from '../workspace-admin/client.js';
import { log } from '../log.js';
import { adminAccountParam } from './shared-params.js';

/**
 * WA10 / WA11 — who receives what is sent to a group.
 *
 * The pair lives in one module because they are one decision read two ways, the
 * way star.ts holds star and unstar.
 *
 * The failure worth explaining is Google's refusal of an address from outside
 * the Workspace. It arrives as a flat "Invalid Input", which reads as a
 * malformed address rather than as a policy on the group — and the address in
 * question is usually the CRM inbox that the whole persona-group arrangement
 * exists to forward into. So the refusal is restated with its actual cure.
 */

const roleParam = z
  .enum(['MEMBER', 'MANAGER', 'OWNER'])
  .optional()
  .describe('MEMBER (the default) receives mail. MANAGER and OWNER can also change the group.');

const deliveryParam = z
  .enum(['ALL_MAIL', 'DAILY', 'DIGEST', 'DISABLED', 'NONE'])
  .optional()
  .describe('How much this member receives: ALL_MAIL for every message, DAILY or DIGEST for a summary, DISABLED or NONE for membership without delivery.');

export const addGroupMemberParams = {
  account: adminAccountParam,
  group_key: z.string().describe("The group's email address, an alias, or its Directory id."),
  email: z.string().describe('The address to add. It can be a person, another group, or an address outside this Workspace if the group allows external members.'),
  role: roleParam,
  delivery_settings: deliveryParam,
};

export const removeGroupMemberParams = {
  account: adminAccountParam,
  group_key: z.string().describe("The group's email address, an alias, or its Directory id."),
  email: z.string().describe('The member to remove. The address itself is untouched — only its membership of this group ends.'),
};

/** Is this Google's refusal of an address from outside the Workspace? */
function looksExternal(message: string): boolean {
  return /external|outside/i.test(message) || /invalid input:\s*memberkey/i.test(message);
}

export function registerGroupMemberTools(server: McpServer): void {
  server.tool(
    'add_group_member',
    'Add an address to a Google Group in the Workspace that the given account administers. '
    + 'WRITES: from then on that address receives the mail sent to the group. The member can be '
    + 'a person, another group, or an address OUTSIDE this Workspace — which is how a persona '
    + 'address forwards into a CRM — but an outside address is refused by Google unless the '
    + 'group has allow_external_members set true, which update_group_settings does.',
    addGroupMemberParams,
    async ({ account, group_key, email, role, delivery_settings }) => {
      try {
        const resolved = requireAdminAccount(account);
        const groupKey = (group_key ?? '').trim();
        const memberEmail = (email ?? '').trim();
        if (!groupKey) throw new Error('add_group_member: group_key is required.');
        if (!memberEmail) throw new Error('add_group_member: email is required.');

        const directory = await getDirectoryClient(resolved);
        const fields = { account: resolved.alias, group: groupKey, member: memberEmail, role: role ?? 'MEMBER' };
        log('info', 'add_group_member', { ...fields, phase: 'start' });

        let added;
        try {
          added = await adminCreateCall(
            {
              tool: 'add_group_member',
              api: ADMIN_SDK_API,
              scope: ADMIN_DIRECTORY_GROUP_MEMBER_SCOPE,
              alias: resolved.alias,
              target: 'group member',
              key: memberEmail,
            },
            { what: `${memberEmail} as a member of ${groupKey}`, check: 'get_group' },
            () => directory.members.insert({
              groupKey,
              requestBody: {
                email: memberEmail,
                role: role ?? 'MEMBER',
                // Google's own field name here really is snake_case, alone
                // among the Directory bodies. Sending deliverySettings is
                // accepted and silently ignored.
                ...(delivery_settings ? { delivery_settings } : {}),
              },
            }),
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log('error', 'add_group_member', { ...fields, phase: 'failed', error: message });
          if (looksExternal(message)) {
            throw new Error(
              `${message}\n\nIf "${memberEmail}" is outside this Workspace, that is what Google `
              + 'is refusing, and its message does not say so. A group only accepts members from '
              + 'other domains once allow_external_members is true — set it with '
              + `update_group_settings on ${groupKey}, then add the member again.`,
            );
          }
          throw err;
        }

        log('info', 'add_group_member', { ...fields, phase: 'done' });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              account: resolved.alias,
              group: groupKey,
              member: projectMember(added.data),
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

  server.tool(
    'remove_group_member',
    'Remove an address from a Google Group in the Workspace that the given account administers. '
    + 'WRITES: from then on that address stops receiving the mail sent to the group. The '
    + 'address itself is untouched — this ends a membership, it does not delete anything. '
    + 'Read the group with get_group first if you are not certain who is in it.',
    removeGroupMemberParams,
    async ({ account, group_key, email }) => {
      try {
        const resolved = requireAdminAccount(account);
        const groupKey = (group_key ?? '').trim();
        const memberEmail = (email ?? '').trim();
        if (!groupKey) throw new Error('remove_group_member: group_key is required.');
        if (!memberEmail) throw new Error('remove_group_member: email is required.');

        const directory = await getDirectoryClient(resolved);
        const fields = { account: resolved.alias, group: groupKey, member: memberEmail };
        log('info', 'remove_group_member', { ...fields, phase: 'start' });

        await adminCreateCall(
          {
            tool: 'remove_group_member',
            api: ADMIN_SDK_API,
            scope: ADMIN_DIRECTORY_GROUP_MEMBER_SCOPE,
            alias: resolved.alias,
            target: 'group member',
            key: memberEmail,
          },
          { what: `the membership of ${memberEmail} in ${groupKey}`, check: 'get_group' },
          () => directory.members.delete({ groupKey, memberKey: memberEmail }),
        );

        log('info', 'remove_group_member', { ...fields, phase: 'done' });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              account: resolved.alias,
              group: groupKey,
              removed: memberEmail,
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
