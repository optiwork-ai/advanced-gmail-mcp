import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { admin_directory_v1 } from 'googleapis';
import {
  ADMIN_DIRECTORY_USER_SCOPE,
  ADMIN_SDK_API,
  adminCall,
  getDirectoryClient,
  projectUserDetail,
  requireAdminAccount,
} from '../workspace-admin/client.js';
import { log } from '../log.js';
import { adminAccountParam } from './shared-params.js';

/**
 * WA13 — change something about a person.
 *
 * `users.patch`, not `users.update`. The installed vendor types expose both
 * (node_modules/googleapis/build/src/apis/admin/directory_v1.d.ts), and they
 * are not interchangeable: `update` REPLACES the user record, so a partial body
 * sent to it blanks everything the caller did not restate — an org unit, a
 * recovery address, a name. `patch` changes only the fields it is given, which
 * is what a tool taking optional fields has to do.
 *
 * Only SUSPENDING is gated. Locking someone out of their mail is the
 * destructive direction and it happens instantly; letting them back in undoes
 * harm rather than doing it, so putting a confirmation in front of that would
 * be friction at the worst possible moment.
 */
export const updateWorkspaceUserParams = {
  account: adminAccountParam,
  user_key: z.string().describe("The person's primary email address, an alias, or their Directory id."),
  given_name: z.string().optional().describe('New first name.'),
  family_name: z.string().optional().describe('New last name.'),
  suspended: z.boolean().optional().describe('true locks the account immediately — no mail, no sign-in — and REQUIRES confirm: true. false lets them back in and does not.'),
  org_unit_path: z.string().optional().describe('Move them to another org unit, e.g. "/Staff".'),
  recovery_email: z.string().optional().describe('New recovery address, outside the Workspace.'),
  confirm: z.boolean().optional().describe('Required to be true ONLY when suspended: true is being set. Pass it only after the user has explicitly asked for this person to be locked out.'),
};

export function registerUpdateWorkspaceUser(server: McpServer): void {
  server.tool(
    'update_workspace_user',
    'Change one or more details of a person in the Google Workspace that the given account '
    + 'administers: their name, their org unit, their recovery address, or whether their '
    + 'account is suspended. WRITES. Only the fields you pass are changed — everything else '
    + 'about the person is left exactly as it was. '
    + 'Suspending is the destructive one: it takes effect immediately, the person cannot sign '
    + 'in and stops receiving mail, and it is REFUSED unless confirm: true is passed. '
    + 'Unsuspending needs no confirmation, because it undoes that rather than doing it. This '
    + 'tool cannot change a password and cannot delete an account.',
    updateWorkspaceUserParams,
    async ({ account, user_key, given_name, family_name, suspended, org_unit_path, recovery_email, confirm }) => {
      try {
        const resolved = requireAdminAccount(account);
        const userKey = (user_key ?? '').trim();
        if (!userKey) throw new Error('update_workspace_user: user_key is required.');

        const requestBody: admin_directory_v1.Schema$User = {};
        const changed: string[] = [];
        const name: admin_directory_v1.Schema$UserName = {};

        if (given_name !== undefined) {
          name.givenName = given_name;
          changed.push('given_name');
        }
        if (family_name !== undefined) {
          name.familyName = family_name;
          changed.push('family_name');
        }
        if (changed.length > 0) requestBody.name = name;

        if (suspended !== undefined) {
          requestBody.suspended = suspended;
          changed.push('suspended');
        }
        if (org_unit_path !== undefined) {
          requestBody.orgUnitPath = org_unit_path;
          changed.push('org_unit_path');
        }
        if (recovery_email !== undefined) {
          requestBody.recoveryEmail = recovery_email;
          changed.push('recovery_email');
        }

        if (changed.length === 0) {
          throw new Error(
            'update_workspace_user: pass at least one of given_name, family_name, suspended, '
            + 'org_unit_path or recovery_email. A call with nothing in it succeeds at Google and '
            + 'changes nothing, which would be reported back as a change that happened.',
          );
        }

        if (suspended === true && confirm !== true) {
          throw new Error(
            `update_workspace_user: refused. Suspending "${userKey}" locks that person out `
            + 'immediately: they cannot sign in and they stop receiving mail. Pass confirm: true '
            + 'only after the user has explicitly asked for this person to be suspended. '
            + '(Unsuspending — suspended: false — needs no confirmation.)',
          );
        }

        const directory = await getDirectoryClient(resolved);
        // The field NAMES, never the values: a name and a recovery address are
        // somebody's personal details and the log is not the place for them.
        const fields = { account: resolved.alias, user: userKey, fields_changed: changed };
        log('info', 'update_workspace_user', { ...fields, phase: 'start' });

        const updated = await adminCall(
          {
            tool: 'update_workspace_user',
            api: ADMIN_SDK_API,
            scope: ADMIN_DIRECTORY_USER_SCOPE,
            alias: resolved.alias,
            target: 'user',
            key: userKey,
          },
          // Idempotent: patching the same fields to the same values twice
          // leaves the person exactly as patching them once does, so the
          // ordinary retries stay on.
          () => directory.users.patch({ userKey, requestBody }),
        );

        log('info', 'update_workspace_user', { ...fields, phase: 'done' });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              account: resolved.alias,
              user: projectUserDetail(updated.data),
              fields_changed: changed,
              ...(suspended === true
                ? { note: `${userKey} is suspended: no sign-in and no mail until this is undone with suspended: false.` }
                : {}),
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
