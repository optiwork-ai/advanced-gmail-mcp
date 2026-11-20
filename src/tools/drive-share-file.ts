import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SHARE_ROLES, shareFile } from '../drive/client.js';

export const shareDriveFileParams = {
  file_id: z.string().describe('The Drive file id (not a link) of a file this server created with upload_drive_file or create_google_doc, on the same account.'),
  recipients: z.array(
    z.object({
      email: z.string().describe('One person\'s email address, e.g. "pat@example.com". No display name, no list.'),
      role: z.enum(SHARE_ROLES).describe('reader (can view), commenter (can view and comment) or writer (can edit). Required; there is no default.'),
    }).strict(),
  ).min(1).describe('The people to share with, each exactly { email, role }. Every entry is checked before anything is shared: one bad entry and nobody is shared with.'),
  account: z.string().optional().describe('Account alias or email address. Must be the account that created the file. Uses default account if not specified.'),
};

/**
 * Give named people access to a Drive file this server created.
 */
export function registerShareDriveFile(server: McpServer): void {
  server.tool(
    'share_drive_file',
    'Give named people access to a Drive file, as reader, commenter or writer, and return Google\'s own list of who can reach it. '
    + 'This WRITES: each person gets real access to the file. '
    + 'It shares only files this server created itself (with upload_drive_file or create_google_doc), on the account that created them; '
    + 'any other file answers that it is out of reach, and re-authenticating will not change that. '
    + 'Named people only: it never turns on link or domain sharing, never shares with a group, and never transfers ownership. '
    + 'It sends no Google notification email, so the caller sends its own message with the file\'s link. '
    + 'The returned "permissions" list is Google\'s read-back after the share, owner included; a person is "granted" only when that read-back shows them at the role asked for. '
    + 'A share made in error is undone with unshare_drive_file.',
    shareDriveFileParams,
    async ({ file_id, recipients, account }) => {
      try {
        const result = await shareFile({
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
