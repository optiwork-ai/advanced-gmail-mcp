import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  ADMIN_DIRECTORY_GROUP_SCOPE,
  ADMIN_SDK_API,
  adminCall,
  getDirectoryClient,
  requireAdminAccount,
} from '../workspace-admin/client.js';
import { errorStatus, googleErrorMessage, googleErrorReasons } from '../scope-error.js';
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

/**
 * The wait-it-out schedule for an alias Google is not ready to accept: six
 * tries at ten seconds — about a minute of patience, then an honest failure.
 *
 * Proven live on three separate Workspaces on 2026-09-02. An alias insert on a
 * group created seconds earlier is refused with **403, reason `forbidden`,
 * "Not Authorized to access this resource/api"** — from a SUPER ADMINISTRATOR.
 * The identical call thirty seconds later returns 200. Google is reporting
 * propagation in a permission error's clothes, and the tool used to pass that
 * on as "you are missing an admin role", which sent the reader to the Admin
 * console to grant themselves something they already had.
 */
export const ALIAS_PROPAGATION_RETRY_DELAYS_MS = [10_000, 10_000, 10_000, 10_000, 10_000, 10_000];

/** The real wait. Replaced by `AddGroupAliasOptions.sleep` in tests. */
function realSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Google's exact words for the refusal that is only propagation. */
const NOT_AUTHORIZED_RE = /not authorized to access this resource\/api/i;

/**
 * True for THAT refusal and nothing else.
 *
 * Deliberately narrow — status, reason and message all have to match. A 403
 * that says anything else (a domain that is not in this Workspace, an address
 * already in use, a genuine role that is genuinely missing) is real, and
 * spending a minute of the caller's time re-asking it would only make a
 * correct answer slower.
 */
function isPropagation403(err: unknown): boolean {
  return errorStatus(err) === 403
    && googleErrorReasons(err).includes('forbidden')
    && NOT_AUTHORIZED_RE.test(googleErrorMessage(err));
}

export interface AddGroupAliasOptions {
  account?: string;
  group_key: string;
  alias: string;
  /**
   * How the propagation retry waits between attempts. Injected so tests spend
   * no wall-clock time; production uses the real timer.
   *
   * On the OPTIONS and deliberately not on `addGroupAliasParams`, for the
   * reason `create_group` documents at length: a `z.function()` in a registered
   * tool's parameter shape cannot become JSON Schema, and the MCP SDK converts
   * every tool's shape in one pass when a client asks what tools exist — so one
   * function parameter anywhere makes `tools/list` throw for the whole roster.
   */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Add an alias to a group, waiting out the minute in which Google may refuse
 * it on a group that was only just created. Returns the answer the tool hands
 * back.
 */
export async function addGroupAlias(opts: AddGroupAliasOptions): Promise<Record<string, unknown>> {
  const resolved = requireAdminAccount(opts.account);
  const groupKey = (opts.group_key ?? '').trim();
  const newAlias = (opts.alias ?? '').trim();
  if (!groupKey) throw new Error('add_group_alias: group_key is required.');
  if (!newAlias) throw new Error('add_group_alias: alias is required.');

  const wait = opts.sleep ?? realSleep;
  const directory = await getDirectoryClient(resolved);
  const fields = { account: resolved.alias, group: groupKey, alias: newAlias };
  log('info', 'add_group_alias', { ...fields, phase: 'start' });

  const ctx = {
    tool: 'add_group_alias',
    api: ADMIN_SDK_API,
    scope: ADMIN_DIRECTORY_GROUP_SCOPE,
    alias: resolved.alias,
    target: 'group alias',
    key: newAlias,
  };

  for (let attempt = 0; ; attempt += 1) {
    // The RAW Google error, kept before `adminCall`'s honest-error translation
    // discards the status and the reason codes this decision needs.
    let raw: unknown;
    try {
      const added = await adminCall(
        ctx,
        async () => {
          try {
            // Retried on a server error too, unlike the creates and deletes
            // here: an alias insert that quietly landed and is sent again is
            // answered "already exists" rather than making a second one, so a
            // retry after a timeout costs nothing and saves a call that would
            // otherwise be reported as failed when it worked.
            return await directory.groups.aliases.insert({
              groupKey,
              requestBody: { alias: newAlias },
            });
          } catch (err: unknown) {
            raw = err;
            throw err;
          }
        },
      );

      log('info', 'add_group_alias', { ...fields, phase: 'done', attempts: attempt + 1 });
      return { account: resolved.alias, group: groupKey, alias: added.data.alias ?? newAlias };
    } catch (err: unknown) {
      const delay = ALIAS_PROPAGATION_RETRY_DELAYS_MS[attempt];
      if (!isPropagation403(raw) || delay === undefined) {
        if (!isPropagation403(raw)) throw err;
        throw new Error(
          `add_group_alias: Google refused the alias "${newAlias}" for "${resolved.alias}", and `
          + `was still refusing it after ${ALIAS_PROPAGATION_RETRY_DELAYS_MS.length} more tries `
          + `over about ${Math.round(
            ALIAS_PROPAGATION_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0) / 1000,
          )} seconds.\n\n`
          + 'On a group created within the last minute this is PROPAGATION, not permission — '
          + 'Google says "not authorized" while the new group is still being published, and the '
          + 'same call usually works a minute later. Wait and run it again.\n\n'
          + 'On a group that has existed for longer, it is a Workspace POLICY or an admin ROLE '
          + 'instead, and signing in again will not change either of them. Check that the alias '
          + 'is on a domain of this Workspace and that nothing else already uses that address.'
          + `\n\nOriginal error: ${googleErrorMessage(raw)}`,
        );
      }

      log('info', 'add_group_alias', {
        ...fields,
        phase: 'waiting',
        attempt: attempt + 1,
        wait_ms: delay,
        why: 'Google refused the alias as "not authorized"; on a new group that is propagation',
      });
      await wait(delay);
    }
  }
}

export function registerAddGroupAlias(server: McpServer): void {
  server.tool(
    'add_group_alias',
    'Add another address that reaches an existing Google Group in the Workspace the given '
    + 'account administers. WRITES: mail sent to the new address is delivered to the group from '
    + 'then on, and the group can send as it. The alias must be on a domain of this Workspace, '
    + 'and no other user, group or alias may already be using it. '
    + 'On a group created within the last minute Google may refuse the alias as "not '
    + 'authorized" while it is still publishing the group; this tool waits that out, retrying '
    + 'for about a minute before giving up. A newly added alias can also take a few seconds to '
    + 'appear, so an immediate get_group may not list it yet.',
    addGroupAliasParams,
    async ({ account, group_key, alias }) => {
      try {
        const answer = await addGroupAlias({ account, group_key, alias });
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
