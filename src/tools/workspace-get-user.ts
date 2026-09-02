import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  ADMIN_DIRECTORY_USER_SCOPE,
  ADMIN_SDK_API,
  adminCall,
  getDirectoryClient,
  projectUserDetail,
  requireAdminAccount,
} from '../workspace-admin/client.js';
import { adminAccountParam } from './shared-params.js';

/** WA3 — one person in the Workspace, with the details a listing leaves out. */
export const getWorkspaceUserParams = {
  account: adminAccountParam,
  user_key: z.string().describe("The person's primary email address, an alias, or their Directory id."),
};

export function registerGetWorkspaceUser(server: McpServer): void {
  server.tool(
    'get_workspace_user',
    'Read one person in the Google Workspace that the given account administers: everything '
    + 'list_workspace_users returns, plus their recovery address, when the account was created, '
    + 'whether they have accepted the terms, whether two-step verification is on, and whether '
    + 'they must change their password at next sign-in. Passwords are never returned. Read-only.',
    getWorkspaceUserParams,
    async ({ account, user_key }) => {
      try {
        const resolved = requireAdminAccount(account);
        const userKey = (user_key ?? '').trim();
        if (!userKey) throw new Error('get_workspace_user: user_key is required.');

        const directory = await getDirectoryClient(resolved);
        const response = await adminCall(
          {
            tool: 'get_workspace_user',
            api: ADMIN_SDK_API,
            scope: ADMIN_DIRECTORY_USER_SCOPE,
            alias: resolved.alias,
            target: 'user',
            key: userKey,
          },
          () => directory.users.get({ userKey }),
        );

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              account: resolved.alias,
              user: projectUserDetail(response.data),
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
