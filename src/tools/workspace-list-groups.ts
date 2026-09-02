import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  ADMIN_DIRECTORY_GROUP_SCOPE,
  ADMIN_SDK_API,
  adminCall,
  customerOrDomain,
  getDirectoryClient,
  projectGroup,
  requireAdminAccount,
} from '../workspace-admin/client.js';
import { adminAccountParam } from './shared-params.js';

/** Google's own ceiling for this call, and it is lower than the users one. */
const MAX_GROUPS_PER_PAGE = 200;
const DEFAULT_GROUPS_PER_PAGE = 100;

/**
 * WA4 — the groups in the Workspace, which is to say most of its addresses:
 * a persona address, a shared inbox and a distribution list are all groups.
 */
export const listGroupsParams = {
  account: adminAccountParam,
  domain: z.string().optional().describe('Narrow to one domain of the Workspace. Omit for every domain in it.'),
  query: z.string().optional().describe('Directory search syntax for groups, e.g. "email:sophie*" or "name:Sales".'),
  user_key: z.string().optional().describe('List only the groups this person belongs to (their address or id). Used on its own — it replaces the domain search rather than narrowing it.'),
  max_results: z.number().optional().describe(`How many to return (default ${DEFAULT_GROUPS_PER_PAGE}, Google's maximum ${MAX_GROUPS_PER_PAGE}; a larger number is capped rather than refused).`),
  page_token: z.string().optional().describe('nextPageToken from a previous call, to read the next page.'),
};

export function registerListGroups(server: McpServer): void {
  server.tool(
    'list_groups',
    'List the Google Groups in the Workspace that the given account administers — which is most '
    + 'of its addresses, because a persona address, a shared inbox and a distribution list are '
    + 'all groups. Returns address, name, description, how many direct members it has, its '
    + 'aliases and whether an administrator created it. Search with Google\'s group query '
    + 'syntax, or pass user_key to list the groups one person belongs to. To see who may post '
    + 'to a group and whether it accepts outside mail, read it with get_group. Read-only.',
    listGroupsParams,
    async ({ account, domain, query, user_key, max_results, page_token }) => {
      try {
        const resolved = requireAdminAccount(account);
        const directory = await getDirectoryClient(resolved);

        const maxResults = Math.min(
          Math.max(1, Math.floor(max_results ?? DEFAULT_GROUPS_PER_PAGE)),
          MAX_GROUPS_PER_PAGE,
        );

        // userKey is an ALTERNATIVE to customer/domain in Google's own
        // parameter list, not a narrowing of it — sending it alongside either
        // asks two different questions in one request.
        const userKey = user_key?.trim();
        const scopeParams = userKey ? { userKey } : customerOrDomain(domain);

        const response = await adminCall(
          {
            tool: 'list_groups',
            api: ADMIN_SDK_API,
            scope: ADMIN_DIRECTORY_GROUP_SCOPE,
            alias: resolved.alias,
            target: 'group list',
            key: userKey || domain?.trim() || 'this Workspace',
          },
          () => directory.groups.list({
            ...scopeParams,
            ...(query?.trim() ? { query: query.trim() } : {}),
            ...(page_token?.trim() ? { pageToken: page_token.trim() } : {}),
            maxResults,
          }),
        );

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              account: resolved.alias,
              groups: (response.data.groups ?? []).map(projectGroup),
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
