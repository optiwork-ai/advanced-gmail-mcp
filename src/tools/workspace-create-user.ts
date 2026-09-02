import { randomInt } from 'node:crypto';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  ADMIN_DIRECTORY_USER_SCOPE,
  ADMIN_SDK_API,
  adminCreateCall,
  getDirectoryClient,
  projectUserDetail,
  requireAdminAccount,
} from '../workspace-admin/client.js';
import { log } from '../log.js';
import { adminAccountParam } from './shared-params.js';

/**
 * WA12 — the only tool here that costs money every month.
 *
 * A Google Group is free; a USER is a licensed seat, billed to that business
 * for as long as it exists, and deleting it later does not refund it. So this
 * one is gated the way delete_group is, and its description says the price out
 * loud rather than leaving it to be discovered on an invoice.
 *
 * The password is the other thing this tool has to get right. If none is given
 * a strong one is minted, returned ONCE in the answer, and never written to the
 * log — the log records that a password was generated, not what it was.
 */

/** The character classes a Workspace password policy typically asks for. */
const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const DIGITS = '23456789';
const SYMBOLS = '!@#$%^&*-_=+?';
const ALL = LOWER + UPPER + DIGITS + SYMBOLS;

/** Long enough that length is not the argument, and short enough to be typed once. */
const PASSWORD_LENGTH = 24;

/**
 * A fresh password from `crypto.randomInt`, guaranteed to carry all four
 * classes — a policy rejection AFTER the seat has been created would leave a
 * paid account nobody can sign into.
 *
 * `randomInt` rather than `randomBytes` with a modulo: taking bytes modulo an
 * alphabet length biases the early characters, and there is no reason to accept
 * that in a credential.
 *
 * Exported for unit testing.
 */
export function generateInitialPassword(): string {
  const pick = (from: string): string => from[randomInt(from.length)];
  const required = [pick(LOWER), pick(UPPER), pick(DIGITS), pick(SYMBOLS)];
  const rest = Array.from({ length: PASSWORD_LENGTH - required.length }, () => pick(ALL));
  const chars = [...required, ...rest];

  // Fisher-Yates, so the four required characters are not always first.
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

export const createWorkspaceUserParams = {
  account: adminAccountParam,
  primary_email: z.string().describe('The new address, on a domain of this Workspace.'),
  given_name: z.string().describe('First name.'),
  family_name: z.string().describe('Last name.'),
  password: z.string().optional().describe('Their first password. Leave it out and a strong one is generated and returned once in the answer.'),
  org_unit_path: z.string().optional().describe('Which org unit to put them in, e.g. "/Staff". Defaults to the top of the Workspace.'),
  recovery_email: z.string().optional().describe('An address outside the Workspace for account recovery.'),
  change_password_at_next_login: z.boolean().optional().describe('Default true. Set false only when the caller supplied a password the person already knows.'),
  confirm: z.boolean().optional().describe('Required to be true. The call is REFUSED without it. Pass it only after the user has explicitly asked for THIS account to be created, knowing it is a paid seat.'),
};

export function registerCreateWorkspaceUser(server: McpServer): void {
  server.tool(
    'create_workspace_user',
    'Create a person in the Google Workspace that the given account administers. WRITES, and '
    + 'it COSTS MONEY: a new user is a PAID Google Workspace seat, billed to that business '
    + 'every month for as long as the account exists, and deleting it later does not refund '
    + 'what has been paid. A shared address, a persona address or a distribution list does NOT '
    + 'need one — create_group makes those and they are free. '
    + 'This is enforced, not advisory: the call is refused unless confirm: true is passed, and '
    + 'you may pass it only after the user has explicitly asked for this specific account to be '
    + 'created. If no password is given, a strong one is generated and shown ONCE in the '
    + 'answer — it is never written to the log and cannot be read back afterwards. The person '
    + 'must change it at first sign-in unless you say otherwise. Not retried on a server error, '
    + 'because a retry after a timeout would create a second person and a second seat.',
    createWorkspaceUserParams,
    async ({
      account, primary_email, given_name, family_name, password,
      org_unit_path, recovery_email, change_password_at_next_login, confirm,
    }) => {
      try {
        const resolved = requireAdminAccount(account);
        const primaryEmail = (primary_email ?? '').trim();
        const givenName = (given_name ?? '').trim();
        const familyName = (family_name ?? '').trim();
        if (!primaryEmail) throw new Error('create_workspace_user: primary_email is required.');
        if (!givenName || !familyName) {
          throw new Error('create_workspace_user: given_name and family_name are both required.');
        }

        if (confirm !== true) {
          throw new Error(
            `create_workspace_user: refused. Creating "${primaryEmail}" adds a PAID Google `
            + 'Workspace seat, billed to that business every month until the account is deleted. '
            + 'If what is wanted is a shared or persona address, use create_group instead — that '
            + 'is free. Pass confirm: true only after the user has explicitly asked for this '
            + 'account to be created.',
          );
        }

        const supplied = typeof password === 'string' && password.length > 0;
        const initialPassword = supplied ? password : generateInitialPassword();
        const mustChange = change_password_at_next_login ?? true;

        const directory = await getDirectoryClient(resolved);

        // Everything a write log should carry and nothing it should not. The
        // password is not here in any form, generated or supplied.
        const fields = {
          account: resolved.alias,
          user: primaryEmail,
          org_unit_path: org_unit_path?.trim() ?? null,
          password_source: supplied ? 'supplied by the caller' : 'generated',
          change_at_next_login: mustChange,
        };
        log('info', 'create_workspace_user', { ...fields, phase: 'start' });

        let created;
        try {
          created = await adminCreateCall(
            {
              tool: 'create_workspace_user',
              api: ADMIN_SDK_API,
              scope: ADMIN_DIRECTORY_USER_SCOPE,
              alias: resolved.alias,
              target: 'user',
              key: primaryEmail,
            },
            { what: `the user ${primaryEmail}`, check: 'get_workspace_user' },
            () => directory.users.insert({
              requestBody: {
                primaryEmail,
                name: { givenName, familyName },
                password: initialPassword,
                changePasswordAtNextLogin: mustChange,
                ...(org_unit_path?.trim() ? { orgUnitPath: org_unit_path.trim() } : {}),
                ...(recovery_email?.trim() ? { recoveryEmail: recovery_email.trim() } : {}),
              },
            }),
          );
        } catch (err) {
          log('error', 'create_workspace_user', {
            ...fields,
            phase: 'failed',
            error: err instanceof Error ? err.message : String(err),
          });
          throw err;
        }

        log('info', 'create_workspace_user', { ...fields, phase: 'done' });

        const answer: Record<string, unknown> = {
          account: resolved.alias,
          user: projectUserDetail(created.data),
          note: `${primaryEmail} is now a paid Google Workspace seat, billed monthly until the `
            + 'account is deleted.',
        };

        if (!supplied) {
          answer.initial_password = initialPassword;
          answer.note = `${String(answer.note)} This answer is the ONLY place the generated `
            + 'password appears — it is not written to the server log and cannot be read back. '
            + 'Give it to the person now; they must change it at first sign-in.';
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
