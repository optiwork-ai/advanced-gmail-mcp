import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  ADMIN_DIRECTORY_DOMAIN_SCOPE,
  ADMIN_SDK_API,
  MY_CUSTOMER,
  adminCall,
  getDirectoryClient,
  requireAdminAccount,
} from '../workspace-admin/client.js';
import { adminAccountParam } from './shared-params.js';

/**
 * WA1 — every domain in the Workspace the given account administers.
 *
 * This is the first call to make on a new admin account, and it settles a
 * question nothing else here can: whether a second domain is its OWN Workspace
 * or a secondary domain of the first one. That decides which account does the
 * work for it, and getting it wrong means an admin call made against the wrong
 * company.
 */
export const listWorkspaceDomainsParams = {
  account: adminAccountParam,
};

export function registerListWorkspaceDomains(server: McpServer): void {
  server.tool(
    'list_workspace_domains',
    'List every domain in the Google Workspace that the given account administers: the domain '
    + 'name, whether it is the primary one, whether it is verified, and its domain aliases. '
    + 'Run this FIRST on any admin account, because it answers a question nothing else does — '
    + 'whether another domain is a Workspace of its own or a secondary domain of this one. '
    + 'A domain that appears here is administered by this account; one that does not needs its '
    + 'own admin account. Read-only.',
    listWorkspaceDomainsParams,
    async ({ account }) => {
      try {
        const resolved = requireAdminAccount(account);
        const directory = await getDirectoryClient(resolved);

        const response = await adminCall(
          {
            tool: 'list_workspace_domains',
            api: ADMIN_SDK_API,
            scope: ADMIN_DIRECTORY_DOMAIN_SCOPE,
            alias: resolved.alias,
            target: 'domain list',
            key: MY_CUSTOMER,
          },
          () => directory.domains.list({ customer: MY_CUSTOMER }),
        );

        const domains = (response.data.domains ?? []).map(domain => ({
          domainName: domain.domainName ?? null,
          isPrimary: domain.isPrimary ?? false,
          verified: domain.verified ?? false,
          domainAliases: (domain.domainAliases ?? [])
            .map(alias => alias.domainAliasName)
            .filter((name): name is string => typeof name === 'string'),
        }));

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ account: resolved.alias, domains }, null, 2),
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
