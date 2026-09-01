import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { MAX_DRIVE_UPLOAD_BYTES, uploadFile } from '../drive/client.js';

const LIMIT_MB = (MAX_DRIVE_UPLOAD_BYTES / 1_000_000).toFixed(0);

export const uploadDriveFileParams = {
  file_path: z.string().describe('ABSOLUTE path to the local file to upload, e.g. "/Users/you/reports/summary.pdf". A relative path is refused rather than resolved against whatever directory the server happens to be running in.'),
  folder_id: z.string().optional().describe('Drive folder id to create the file in. Omit to put it in the account\'s My Drive root. Because this server holds the narrow "drive.file" scope, a folder it did not itself create may not be reachable — if a folder id errors, upload to the root and move the file in Drive.'),
  name: z.string().optional().describe('Name for the file in Drive. Defaults to the local file\'s own name.'),
  convert: z.boolean().optional().describe('Convert the upload into the native Google equivalent (spreadsheet/document/presentation) so it opens as a real Google file instead of a stored Office/CSV file. Emails nobody, changes nothing else. Works for xlsx, xls, ods, csv, tsv (Sheets), docx, doc, odt, rtf, txt (Docs) and pptx, ppt, odp (Slides); any other type is refused before the upload starts rather than stored unconverted. Leave it off to keep the file exactly as it is on disk.'),
  account: z.string().optional().describe('Account alias or email address. Uses default account if not specified.'),
};

/**
 * Upload a local file to Google Drive. The only Drive tool that writes.
 */
export function registerUploadDriveFile(server: McpServer): void {
  server.tool(
    'upload_drive_file',
    'Upload a local file to the account\'s Google Drive and return its file id, name, size and webViewLink. '
    + 'This WRITES to Drive — it creates a new file every time it is called; it never overwrites or updates an existing one. '
    + `The path must be absolute, must point at a regular file, and the file must be under ${LIMIT_MB}MB. `
    + 'REQUIRES the "drive.file" scope, which was added on 2026-08-27: any account whose token was issued before then '
    + 'will answer 403 until it re-consents with "npm run auth -- <alias>". A 403 here means the grant is missing, not that the login is broken. '
    + 'Note that "drive.file" only ever gives this server access to files it created itself — reading the rest of the user\'s Drive still goes through search_drive_files / read_drive_file. '
    + 'Set convert:true to have the upload land as a REAL Google Sheet, Doc or Slides deck rather than a stored .xlsx/.csv/.docx — that is what makes a spreadsheet openable and editable in Google Sheets, '
    + 'and what puts it inside this server\'s reach for update_sheet_values / append_sheet_rows afterwards. A type Google cannot convert is refused before anything is uploaded.',
    uploadDriveFileParams,
    async ({ file_path, folder_id, name, convert, account }) => {
      try {
        const result = await uploadFile({
          filePath: file_path,
          folderId: folder_id ?? undefined,
          name: name ?? undefined,
          convert: convert ?? undefined,
          account: account ?? undefined,
        });

        return {
          content: [
            { type: 'text' as const, text: JSON.stringify({ success: true, ...result }, null, 2) },
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
