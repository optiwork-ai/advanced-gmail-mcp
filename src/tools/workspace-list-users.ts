import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  ADMIN_DIRECTORY_USER_SCOPE,
  ADMIN_SDK_API,
  adminCall,
  customerOrDomain,
  getDirectoryClient,
  projectUser,
  requireAdminAccount,
} from '../workspace-admin/client.js';
import { adminAccountParam } from './shared-params.js';

/** Google's own ceiling for this call. */
const MAX_USERS_PER_PAGE = 500;
const DEFAULT_USERS_PER_PAGE = 100;

/**
 * WA2 — the people in the Workspace.
 *
 * The projection is an allow-list rather than an omission list. The Directory
 * API does not return passwords on a read, but `Schema$User` has a `password`
 * field and a `hashFunction` field, and an answer assembled by deleting the
 * fields we do not want would be one Google change away from carrying them.
 */
export const listWorkspaceUsersParams = {
  account: adminAccountParam,
  domain: z.string().optional().describe('Narrow to one domain of the Workspace. Omit for every domain in it.'),
  query: z.string().optional().describe('Directory search syntax, e.g. "email:emma*", "isAdmin=true", "orgUnitPath=/Staff". Omit to list everybody.'),
  max_results: z.number().optional().describe(`How many to return (default ${DEFAULT_USERS_PER_PAGE}, Google's maximum ${MAX_USERS_PER_PAGE}; a larger number is capped rather than refused).`),
  page_token: z.string().optional().describe('nextPageToken from a previous call, to read the next page.'),
};

export function registerListWorkspaceUsers(server: McpServer): void {
  server.tool(
    'list_workspace_users',
    'List the people in the Google Workspace that the given account administers: address, full '
    + 'name, whether the account is suspended, whether they are an administrator, org unit, '
    + 'aliases and last sign-in. Optionally narrowed to one domain or filtered with Google\'s '
    + 'directory search syntax. Passwords are never returned — Google does not send them and '
    + 'this tool would not pass them on. Read-only.',
    listWorkspaceUsersParams,
    async ({ account, domain, query, max_results, page_token }) => {
      try {
        const resolved = requireAdminAccount(account);
        const directory = await getDirectoryClient(resolved);

        const maxResults = Math.min(
          Math.max(1, Math.floor(max_results ?? DEFAULT_USERS_PER_PAGE)),
          MAX_USERS_PER_PAGE,
        );

        const response = await adminCall(
          {
            tool: 'list_workspace_users',
            api: ADMIN_SDK_API,
            scope: ADMIN_DIRECTORY_USER_SCOPE,
            alias: resolved.alias,
            target: 'user list',
            key: domain?.trim() || 'this Workspace',
          },
          () => directory.users.list({
            ...customerOrDomain(domain),
            ...(query?.trim() ? { query: query.trim() } : {}),
            ...(page_token?.trim() ? { pageToken: page_token.trim() } : {}),
            maxResults,
            // No `orderBy`. The installed vendor types declare it only as
            // `orderBy?: string` and document none of its accepted values, and
            // this session could make no live call to find out which spelling
            // Google wants — a wrong one would 400 the whole listing rather
            // than degrade. Google's default order is fine, and adding a sort
            // is a one-line change once somebody has seen the API answer.
          }),
        );

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              account: resolved.alias,
              users: (response.data.users ?? []).map(projectUser),
              nextPageToken: response.data.nextPageToken ?? null,
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
