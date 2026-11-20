import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { unshareFile } from '../drive/client.js';

export const unshareDriveFileParams = {
  file_id: z.string().describe('The Drive file id (not a link) of a file this server created with upload_drive_file or create_google_doc, on the same account.'),
  recipients: z.array(z.string()).min(1).describe('The people whose own access to remove, each one plain email address, e.g. "pat@example.com". Every entry is checked before anything is removed: one bad entry and nothing is removed.'),
  account: z.string().optional().describe('Account alias or email address. Must be the account that created the file. Uses default account if not specified.'),
};

/**
 * Remove a named person's own access from a Drive file this server created.
 */
export function registerUnshareDriveFile(server: McpServer): void {
  server.tool(
    'unshare_drive_file',
    'Remove named people\'s access to a Drive file and return Google\'s own list of who can still reach it. '
    + 'This WRITES: each person named loses their access to the file. '
    + 'It works only on files this server created itself (with upload_drive_file or create_google_doc), on the account that created them; '
    + 'any other file answers that it is out of reach, and re-authenticating will not change that. '
    + 'It removes a named person\'s own access and nothing else: never the owner, a group, a domain or link sharing. '
    + 'It removes that person\'s access whoever granted it. The address must match the one Google lists, ignoring case only; '
    + 'an address with no access is reported as "not_found", not as an error, so compare it against the returned list. '
    + 'Google sends no notification of a removal. '
    + 'The returned "permissions" list is Google\'s read-back after the removal; a read taken immediately afterwards may briefly lag, so an "unconfirmed" person is worth reading again after a moment. '
    + 'Each result keeps the role the person held, and access is restored with share_drive_file at that role.',
    unshareDriveFileParams,
    async ({ file_id, recipients, account }) => {
      try {
        const result = await unshareFile({
          fileId: file_id,
          recipients,
          account: account ?? undefined,
        });

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
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
