import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  ADMIN_DIRECTORY_GROUP_MEMBER_SCOPE,
  ADMIN_DIRECTORY_GROUP_SCOPE,
  ADMIN_SDK_API,
  GROUPS_SETTINGS_API,
  GROUPS_SETTINGS_SCOPE,
  adminCall,
  fromGoogleSettings,
  getDirectoryClient,
  getGroupsSettingsClient,
  projectGroup,
  projectMember,
  requireAdminAccount,
} from '../workspace-admin/client.js';
import { adminAccountParam } from './shared-params.js';

/** As many members as Google will return in one page. */
const MEMBERS_PER_CALL = 200;

/**
 * WA5 — the one call that shows an address's WHOLE posture.
 *
 * Three reads, deliberately, because the answer people actually need is spread
 * across two APIs: the Directory knows the group exists and who is in it, and
 * Groups Settings knows who may post to it, whether mail from outside the
 * company is accepted at all, and where it goes. Reading only the first half is
 * how an address gets reported as "fine" while silently rejecting every message
 * a stranger sends it.
 *
 * The Directory read is the one that must succeed. The other two are extras,
 * and a failure in either is reported BESIDE the group rather than instead of
 * it — with the failure spelled out, because a missing `settings` block would
 * otherwise read as "no restrictions", which is the opposite of the truth.
 */
export const getGroupParams = {
  account: adminAccountParam,
  group_key: z.string().describe("The group's email address, one of its aliases, or its Directory id."),
};

export function registerGetGroup(server: McpServer): void {
  server.tool(
    'get_group',
    'Read one Google Group in the Workspace that the given account administers, in full: the '
    + 'group itself, its SETTINGS, and its members. This is the call that shows an address\'s '
    + 'whole posture — who is allowed to post to it, whether mail from outside the company is '
    + 'accepted or refused, whether messages are held for moderation, and who receives what is '
    + 'sent there. Reading the group without its settings is how an address gets reported as '
    + 'working while it quietly rejects every message a stranger sends it. Up to '
    + `${MEMBERS_PER_CALL} members are listed, and the answer says so when there are more. `
    + 'Read-only.',
    getGroupParams,
    async ({ account, group_key }) => {
      try {
        const resolved = requireAdminAccount(account);
        const groupKey = (group_key ?? '').trim();
        if (!groupKey) throw new Error('get_group: group_key is required.');

        const directory = await getDirectoryClient(resolved);
        const directoryCtx = {
          tool: 'get_group',
          api: ADMIN_SDK_API,
          scope: ADMIN_DIRECTORY_GROUP_SCOPE,
          alias: resolved.alias,
          target: 'group',
          key: groupKey,
        };

        // The read that has to work. A failure here is a failure of the tool.
        const found = await adminCall(directoryCtx, () => directory.groups.get({ groupKey }));
        const group = found.data;
        const email = group.email ?? groupKey;

        const answer: Record<string, unknown> = {
          account: resolved.alias,
          group: projectGroup(group),
        };

        // Extra 1: the settings, keyed on the ADDRESS — Groups Settings accepts
        // nothing else, so asking by id would 404 on a group that plainly exists.
        try {
          const settingsClient = await getGroupsSettingsClient(resolved);
          const settings = await adminCall(
            {
              tool: 'get_group',
              api: GROUPS_SETTINGS_API,
              scope: GROUPS_SETTINGS_SCOPE,
              alias: resolved.alias,
              target: 'group settings record',
              key: email,
            },
            () => settingsClient.groups.get({ groupUniqueId: email, alt: 'json' }),
          );
          answer.settings = fromGoogleSettings(settings.data);
        } catch (err) {
          answer.settings = null;
          answer.settings_error = err instanceof Error ? err.message : String(err);
          answer.note = 'The group was read, but its SETTINGS could not be. Do not read the '
            + 'missing settings as "no restrictions" — this answer does not say whether the '
            + 'address accepts mail from outside the company. See settings_error.';
        }

        // Extra 2: the members.
        try {
          const members = await adminCall(
            {
              tool: 'get_group',
              api: ADMIN_SDK_API,
              scope: ADMIN_DIRECTORY_GROUP_MEMBER_SCOPE,
              alias: resolved.alias,
              target: 'group member list',
              key: email,
            },
            () => directory.members.list({ groupKey, maxResults: MEMBERS_PER_CALL }),
          );
          answer.members = (members.data.members ?? []).map(projectMember);
          if (members.data.nextPageToken) answer.members_truncated = true;
        } catch (err) {
          answer.members = null;
          answer.members_error = err instanceof Error ? err.message : String(err);
        }

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(answer, null, 2) }],
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
