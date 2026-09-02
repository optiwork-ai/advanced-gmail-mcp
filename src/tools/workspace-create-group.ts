import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  ADMIN_DIRECTORY_GROUP_MEMBER_SCOPE,
  ADMIN_DIRECTORY_GROUP_SCOPE,
  ADMIN_SDK_API,
  GROUPS_SETTINGS_API,
  GROUPS_SETTINGS_SCOPE,
  type GroupSettings,
  adminCall,
  adminCreateCall,
  fromGoogleSettings,
  getDirectoryClient,
  getGroupsSettingsClient,
  projectGroup,
  requireAdminAccount,
  toGoogleSettings,
} from '../workspace-admin/client.js';
import { errorStatus } from '../scope-error.js';
import { log } from '../log.js';
import { GROUP_SETTINGS_DESCRIPTION, adminAccountParam, groupSettingsSchema } from './shared-params.js';

/**
 * WA6 — create a group, configure it, and put people in it. Three steps, and
 * the answer says which of them happened.
 *
 * The ORDER is load-bearing. Settings come before members because an address
 * outside the domain — the CRM's inbound mailbox, which is the whole reason a
 * persona group exists — cannot be added to a group until
 * `allowExternalMembers` is true. Adding members first would fail on exactly
 * the member that matters.
 *
 * Nothing is rolled back. If the settings fail, the group still exists and mail
 * will start arriving at the address; deleting it to tidy up would be a second
 * unasked-for write. The result says plainly what landed, and the cure for each
 * half is one follow-up call.
 */

/**
 * The re-check schedule for a group Google has not finished publishing: five
 * tries at 1s, 2s, 3s, 4s, 5s — ~15s worst case, then an honest failure.
 *
 * `groups.insert` returns as soon as the group exists in the Directory, but the
 * Groups Settings API can answer 404 for it for several seconds afterwards.
 * Treating that first 404 as the answer would report a group created with none
 * of the settings it was created FOR. The same bounded-poll shape the Meet-room
 * re-read uses in src/calendar/client.ts.
 */
export const GROUP_SETTINGS_RETRY_DELAYS_MS = [1000, 2000, 3000, 4000, 5000];

/** The real wait. Replaced by `CreateGroupOptions.sleep` in tests. */
function realSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const memberSchema = z.object({
  email: z.string(),
  role: z.enum(['MEMBER', 'MANAGER', 'OWNER']).optional(),
});

export const createGroupParams = {
  account: adminAccountParam,
  email: z.string().describe('The address of the new group, e.g. "sophie@appraisalhost.com". It must be on a domain of this Workspace.'),
  name: z.string().describe('The display name, e.g. "Sophie Bennett".'),
  description: z.string().optional().describe('What the address is for, as an administrator would read it later.'),
  settings: groupSettingsSchema.optional().describe(GROUP_SETTINGS_DESCRIPTION),
  members: z.array(memberSchema).optional().describe('Addresses to add, each optionally with a role (MEMBER by default). An address OUTSIDE this Workspace can only be added if allow_external_members is true, which is why settings are applied first.'),
};

export interface CreateGroupMember {
  email: string;
  role?: 'MEMBER' | 'MANAGER' | 'OWNER';
}

export interface CreateGroupOptions {
  account?: string;
  email: string;
  name: string;
  description?: string;
  settings?: GroupSettings;
  members?: CreateGroupMember[];
  /**
   * How the settings retry waits between attempts. Injected so tests spend no
   * wall-clock time; production uses the real timer.
   *
   * It lives on the OPTIONS and deliberately not on `createGroupParams`: a
   * `z.function()` in a tool's parameter shape cannot be turned into JSON
   * Schema, and the MCP SDK converts every registered tool's shape whenever a
   * client asks what tools exist — so one function parameter anywhere breaks
   * the entire roster's listing, not merely its own tool. `tools/list` throws.
   * `src/tools/index.test.ts` now pins that for all of them. This is the same
   * split `src/calendar/client.ts` uses for the Meet-room poll.
   */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Create a group, apply its settings, add its members. Returns the answer the
 * tool hands back, which names exactly which of the three landed.
 */
export async function createGroup(opts: CreateGroupOptions): Promise<Record<string, unknown>> {
  const resolved = requireAdminAccount(opts.account);
  const groupEmail = (opts.email ?? '').trim();
  const groupName = (opts.name ?? '').trim();
  if (!groupEmail) throw new Error('create_group: email is required.');
  if (!groupName) throw new Error('create_group: name is required.');

  const wait = opts.sleep ?? realSleep;
  const description = opts.description?.trim();

  // Validated BEFORE the group is created, so an unwritable setting is refused
  // while there is still nothing to clean up.
  const settingsBody = opts.settings ? toGoogleSettings(opts.settings) : undefined;

  const directory = await getDirectoryClient(resolved);
  const fields = {
    account: resolved.alias,
    group: groupEmail,
    settings: opts.settings ? Object.keys(opts.settings) : [],
    members: (opts.members ?? []).length,
  };
  log('info', 'create_group', { ...fields, phase: 'start' });

  // --- step 1: the group itself --------------------------------------------
  let created;
  try {
    created = await adminCreateCall(
      {
        tool: 'create_group',
        api: ADMIN_SDK_API,
        scope: ADMIN_DIRECTORY_GROUP_SCOPE,
        alias: resolved.alias,
        target: 'group',
        key: groupEmail,
      },
      { what: `the group ${groupEmail}`, check: 'get_group' },
      () => directory.groups.insert({
        requestBody: {
          email: groupEmail,
          name: groupName,
          ...(description ? { description } : {}),
        },
      }),
    );
  } catch (err) {
    log('error', 'create_group', {
      ...fields,
      phase: 'failed',
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  const answer: Record<string, unknown> = {
    account: resolved.alias,
    group: projectGroup(created.data),
  };
  const notes: string[] = [];

  // --- step 2: the settings -------------------------------------------------
  if (!settingsBody) {
    answer.settings_applied = 'not requested';
  } else {
    const settingsClient = await getGroupsSettingsClient(resolved);
    const settingsCtx = {
      tool: 'create_group',
      api: GROUPS_SETTINGS_API,
      scope: GROUPS_SETTINGS_SCOPE,
      alias: resolved.alias,
      target: 'group settings record',
      key: groupEmail,
    };

    let applied = false;
    let lastError: unknown;
    for (let attempt = 0; attempt <= GROUP_SETTINGS_RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        const patched = await adminCall(settingsCtx, () => settingsClient.groups.patch({
          groupUniqueId: groupEmail,
          requestBody: settingsBody,
        }));
        answer.settings = fromGoogleSettings(patched.data);
        applied = true;
        break;
      } catch (err) {
        lastError = err;
        // ONLY a 404 is worth waiting out: it is the eventual-consistency
        // answer for a group created a moment ago. Anything else will say the
        // same thing in five seconds' time.
        const notYetVisible = errorStatus(err) === 404
          || (err instanceof Error && /no such group/i.test(err.message));
        const delay = GROUP_SETTINGS_RETRY_DELAYS_MS[attempt];
        if (!notYetVisible || delay === undefined) break;
        await wait(delay);
      }
    }

    answer.settings_applied = applied;
    if (!applied) {
      answer.settings_error = lastError instanceof Error ? lastError.message : String(lastError);
      notes.push(
        `The group ${groupEmail} WAS created and still exists, but its settings were not `
        + 'applied. Until they are it has Google\'s defaults, which refuse mail from outside '
        + 'this Workspace. Apply them with update_group_settings.',
      );
    }
  }

  // --- step 3: the members --------------------------------------------------
  const added: string[] = [];
  const failed: Array<{ email: string; error: string }> = [];

  for (const member of opts.members ?? []) {
    const memberEmail = (member.email ?? '').trim();
    if (!memberEmail) continue;
    try {
      await adminCreateCall(
        {
          tool: 'create_group',
          api: ADMIN_SDK_API,
          scope: ADMIN_DIRECTORY_GROUP_MEMBER_SCOPE,
          alias: resolved.alias,
          target: 'group member',
          key: memberEmail,
        },
        { what: `${memberEmail} as a member of ${groupEmail}`, check: 'get_group' },
        () => directory.members.insert({
          groupKey: groupEmail,
          requestBody: { email: memberEmail, role: member.role ?? 'MEMBER' },
        }),
      );
      added.push(memberEmail);
    } catch (err) {
      failed.push({ email: memberEmail, error: err instanceof Error ? err.message : String(err) });
    }
  }

  answer.members_added = added;
  answer.members_failed = failed;
  if (failed.length > 0) {
    notes.push(
      `${failed.length} of ${added.length + failed.length} members could not be added. The group `
      + 'exists and the ones in members_added are in it; add the rest with add_group_member. An '
      + 'address outside this Workspace needs allow_external_members true first.',
    );
  }
  if (notes.length > 0) answer.note = notes.join(' ');

  log('info', 'create_group', {
    ...fields,
    phase: 'done',
    settings_applied: answer.settings_applied,
    members_added: added.length,
    members_failed: failed.length,
  });

  return answer;
}

export function registerCreateGroup(server: McpServer): void {
  server.tool(
    'create_group',
    'Create a Google Group in the Workspace that the given account administers, and optionally '
    + 'configure it and fill it, in one call. WRITES: the address exists afterwards and mail '
    + 'sent to it is delivered. Creating a group is FREE — it costs no licence and no monthly '
    + 'fee, unlike create_workspace_user, which is why a shared or persona address should '
    + 'almost always be a group rather than a person. '
    + 'Three steps happen in order: the group is created, then its settings are applied, then '
    + 'members are added. Settings come before members because an address outside this '
    + 'Workspace cannot be added until allow_external_members is true. Nothing is rolled back '
    + 'if a later step fails: the result says exactly which steps landed, and the group is left '
    + 'in place rather than silently deleted. It is not retried on a server error, because a '
    + 'retry after a timeout would make a second group.',
    createGroupParams,
    async ({ account, email, name, description, settings, members }) => {
      try {
        const answer = await createGroup({
          account,
          email,
          name,
          description: description ?? undefined,
          settings: (settings ?? undefined) as GroupSettings | undefined,
          members: (members ?? undefined) as CreateGroupMember[] | undefined,
        });
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
