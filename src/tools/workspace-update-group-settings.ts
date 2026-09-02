import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  ADMIN_DIRECTORY_GROUP_SCOPE,
  ADMIN_SDK_API,
  GROUPS_SETTINGS_API,
  GROUPS_SETTINGS_SCOPE,
  type GroupSettings,
  adminCall,
  fromGoogleSettings,
  getDirectoryClient,
  getGroupsSettingsClient,
  requireAdminAccount,
  resolveGroupEmail,
  toGoogleSettings,
} from '../workspace-admin/client.js';
import { log } from '../log.js';
import { GROUP_SETTINGS_DESCRIPTION, adminAccountParam, groupSettingsSchema } from './shared-params.js';

/**
 * WA7 — change what a group does with the mail sent to it.
 *
 * The answer is a RE-READ, not an echo of the request. What a caller needs to
 * know is what the group is set to now, and Google is the only authority on
 * that: a patch that was accepted but adjusted, or silently ignored, would look
 * identical to one that took effect if the request were simply reflected back.
 */
export const updateGroupSettingsParams = {
  account: adminAccountParam,
  group_key: z.string().describe("The group's email address (an id or alias is resolved to it first)."),
  settings: groupSettingsSchema.describe(GROUP_SETTINGS_DESCRIPTION),
};

export function registerUpdateGroupSettings(server: McpServer): void {
  server.tool(
    'update_group_settings',
    'Change the settings of a Google Group in the Workspace that the given account administers. '
    + 'WRITES: this changes how the address behaves for everyone who mails it — in particular '
    + 'whether mail from outside the company is accepted or refused, and whether messages are '
    + 'held for moderation. Only the settings you pass are changed; everything else about the '
    + 'group is left alone. The answer is a fresh READ of the group afterwards rather than an '
    + 'echo of the request, so it says what Google actually holds now.',
    updateGroupSettingsParams,
    async ({ account, group_key, settings }) => {
      try {
        const resolved = requireAdminAccount(account);
        const groupKey = (group_key ?? '').trim();
        if (!groupKey) throw new Error('update_group_settings: group_key is required.');

        const requested = (settings ?? {}) as GroupSettings;
        if (Object.keys(requested).length === 0) {
          throw new Error(
            'update_group_settings: pass at least one setting. A patch with nothing in it '
            + 'succeeds at Google and changes nothing, which would be reported back as a change '
            + 'that happened.',
          );
        }

        // Validated before anything is sent, so an unwritable key is refused
        // here rather than by Google under a name the caller never typed.
        const body = toGoogleSettings(requested);

        const directory = await getDirectoryClient(resolved);
        const { email } = await resolveGroupEmail(directory, groupKey, {
          tool: 'update_group_settings',
          api: ADMIN_SDK_API,
          scope: ADMIN_DIRECTORY_GROUP_SCOPE,
          alias: resolved.alias,
          target: 'group',
          key: groupKey,
        });

        const settingsClient = await getGroupsSettingsClient(resolved);
        const ctx = {
          tool: 'update_group_settings',
          api: GROUPS_SETTINGS_API,
          scope: GROUPS_SETTINGS_SCOPE,
          alias: resolved.alias,
          target: 'group settings record',
          key: email,
        };

        // The field NAMES, never their values: a settings log should say what
        // was touched without becoming a second copy of the configuration.
        const fields = { account: resolved.alias, group: email, settings: Object.keys(requested) };
        log('info', 'update_group_settings', { ...fields, phase: 'start' });

        try {
          // A settings patch is idempotent — the same body twice leaves the
          // group exactly as it does once — so the normal retries stay on.
          await adminCall(ctx, () => settingsClient.groups.patch({
            groupUniqueId: email,
            alt: 'json',
            requestBody: body,
          }));
        } catch (err) {
          log('error', 'update_group_settings', {
            ...fields,
            phase: 'failed',
            error: err instanceof Error ? err.message : String(err),
          });
          throw err;
        }

        const after = await adminCall(ctx, () => settingsClient.groups.get({ groupUniqueId: email, alt: 'json' }));
        log('info', 'update_group_settings', { ...fields, phase: 'done' });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              account: resolved.alias,
              group: email,
              settings: fromGoogleSettings(after.data),
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
