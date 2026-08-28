import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { drive_v3 } from 'googleapis';
import { DRIVE_READONLY_SCOPE, getDriveClient } from '../drive/client.js';
import { resolveAccount } from '../config.js';
import { googleApiCall } from '../google-api-error.js';

export const searchDriveFilesParams = {
  query: z.string().optional().describe('Drive search query in Drive "q" syntax, e.g. "name contains \'report\'", "mimeType = \'application/vnd.google-apps.document\'", "modifiedTime > \'2024-01-01T00:00:00\'". Omit to list recent files.'),
  account: z.string().optional().describe('Account alias or email address. Uses default account if not specified.'),
  order_by: z.string().optional().describe('Drive orderBy expression, e.g. "modifiedTime desc" or "name". Optional.'),
  max_results: z.number().optional().describe('Maximum number of files to return (default: 100, max: 1000). Paginates automatically.'),
  include_shared_drives: z.boolean().optional().describe('Whether to search shared (team) drives as well as the account\'s own My Drive. Defaults to TRUE, because a file the user can see is a file they expect to find. Pass false to search only My Drive, which is marginally faster.'),
};

/**
 * READ-ONLY: search / list Drive files.
 */
export function registerSearchDriveFiles(server: McpServer): void {
  server.tool(
    'search_drive_files',
    'Search Google Drive files using Drive "q" query syntax. Read-only. '
    + 'Searches the account\'s own My Drive AND every shared (team) drive it can see, unless '
    + 'include_shared_drives is set to false. '
    + 'Returns file id, name, mimeType, modifiedTime, owners, webViewLink, parents, and driveId '
    + '(present only on a file that lives in a shared drive).',
    searchDriveFilesParams,
    async ({ query, account, order_by, max_results, include_shared_drives }) => {
      try {
        const resolved = resolveAccount(account ?? undefined);
        const drive = await getDriveClient(resolved);
        const ctx = { tool: 'search_drive_files', api: 'Google Drive', scope: DRIVE_READONLY_SCOPE, alias: resolved.alias };
        const maxResults = Math.min(max_results ?? 100, 1000);
        // Default TRUE: a file the user can see is a file they expect to find.
        const includeSharedDrives = include_shared_drives ?? true;

        const files: drive_v3.Schema$File[] = [];
        let pageToken: string | undefined;

        while (files.length < maxResults) {
          const pageSize = Math.min(maxResults - files.length, 1000);
          const response = await googleApiCall(ctx, () =>
            drive.files.list({
              q: query || undefined,
              orderBy: order_by || undefined,
              pageSize,
              pageToken,
              // All three are required TOGETHER. supportsAllDrives alone only
              // says the caller can handle a shared-drive item; without
              // includeItemsFromAllDrives none is returned, and without
              // corpora: 'allDrives' the search still only looks at My Drive
              // (Drive defaults corpora to 'user').
              supportsAllDrives: true,
              includeItemsFromAllDrives: includeSharedDrives,
              corpora: includeSharedDrives ? 'allDrives' : 'user',
              fields: 'files(id,name,mimeType,modifiedTime,owners,webViewLink,parents,driveId),nextPageToken',
            })
          );

          const page = response.data.files || [];
          files.push(...page);

          pageToken = response.data.nextPageToken ?? undefined;
          if (!pageToken || page.length === 0) break;
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(files.slice(0, maxResults), null, 2),
            },
          ],
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
