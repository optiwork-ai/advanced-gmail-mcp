import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getDriveClient } from '../drive/client.js';
import { withRetry } from '../gmail/client.js';

export const readDriveFileParams = {
  file_id: z.string().describe('The Drive file id to read.'),
  account: z.string().optional().describe('Account alias or email address. Uses default account if not specified.'),
};

// ~1MB cap on returned text content. Larger content is truncated with a note.
const MAX_CONTENT_BYTES = 1_000_000;

// Google Workspace editor types -> the text-ish MIME to export them as.
const GOOGLE_APPS_EXPORT: Record<string, string> = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
};

/**
 * What each export silently loses.
 *
 * These were real data-loss cases returned with `contentNote: null`: a
 * multi-tab workbook came back as its first sheet only, and a deck came back
 * with its speaker notes and slide structure gone. Saying so is the fix; the
 * export formats themselves are what the Drive API offers.
 */
const EXPORT_LIMITATIONS: Record<string, string> = {
  'application/vnd.google-apps.spreadsheet':
    'Drive\'s CSV export returns ONLY THE FIRST SHEET of a spreadsheet. If the workbook has '
    + 'more tabs, their content is not in this response — open it in Sheets or export each '
    + 'tab separately.',
  'application/vnd.google-apps.presentation':
    'The plain-text export of a presentation drops speaker notes and slide structure; only '
    + 'the slide text is returned.',
};

/** Join the limitation note and the truncation note into one contentNote. */
function composeNote(...parts: Array<string | null>): string | null {
  const kept = parts.filter((p): p is string => !!p);
  return kept.length > 0 ? kept.join(' ') : null;
}

/**
 * Decide whether a non-Workspace MIME type is safe to return as text.
 */
function isTextMime(mimeType: string): boolean {
  if (mimeType.startsWith('text/')) return true;
  if (mimeType.endsWith('+json') || mimeType.endsWith('+xml')) return true;
  return new Set([
    'application/json',
    'application/xml',
    'application/rtf',
    'application/javascript',
    'application/x-ndjson',
    'application/csv',
  ]).has(mimeType);
}

/**
 * Cap a string at MAX_CONTENT_BYTES, returning [content, truncated].
 */
function capContent(text: string): { content: string; truncated: boolean } {
  const bytes = Buffer.byteLength(text, 'utf-8');
  if (bytes <= MAX_CONTENT_BYTES) return { content: text, truncated: false };
  // Slice by bytes, then re-decode (may drop a partial trailing char — fine).
  const sliced = Buffer.from(text, 'utf-8').subarray(0, MAX_CONTENT_BYTES).toString('utf-8');
  return { content: sliced, truncated: true };
}

/**
 * READ-ONLY: read a Drive file's metadata and (where safe) its text content.
 * Google Docs/Sheets/Slides are exported to text; other text files are read via
 * alt=media; binary/unknown types return metadata plus a note (no raw bytes).
 */
export function registerReadDriveFile(server: McpServer): void {
  server.tool(
    'read_drive_file',
    'Read a Google Drive file: returns metadata plus text content where possible. Read-only. '
    + 'Google Docs/Sheets/Slides are exported to plain text/CSV; other text files are read '
    + 'directly; binary/unknown types return metadata and a note (never raw bytes). Content is '
    + 'capped at ~1MB and truncation is flagged. Read contentNote before trusting the content: '
    + 'a Sheets export returns ONLY the first sheet, and a Slides export drops speaker notes.',
    readDriveFileParams,
    async ({ file_id, account }) => {
      try {
        const drive = await getDriveClient(account ?? undefined);

        const metaResp = await withRetry(() =>
          drive.files.get({
            fileId: file_id,
            fields: 'id,name,mimeType,size,modifiedTime,owners,webViewLink,parents',
          })
        );
        const meta = metaResp.data;
        const mimeType = meta.mimeType || '';

        const result: Record<string, unknown> = {
          metadata: meta,
          content: null,
          contentNote: null as string | null,
          truncated: false,
        };

        if (mimeType.startsWith('application/vnd.google-apps')) {
          const exportMime = GOOGLE_APPS_EXPORT[mimeType];
          if (!exportMime) {
            result.contentNote = `Google Workspace type "${mimeType}" cannot be exported as text; metadata only.`;
          } else {
            const resp = await withRetry(() =>
              drive.files.export(
                { fileId: file_id, mimeType: exportMime },
                { responseType: 'text' }
              )
            );
            // Drive's export endpoint does not honour Range, so the bound here
            // is capContent's: the export is fetched and then capped, and the
            // truncation is always declared rather than left implicit.
            const { content, truncated } = capContent(String(resp.data ?? ''));
            result.content = content;
            result.truncated = truncated;
            result.exportedAs = exportMime;
            result.contentNote = composeNote(
              EXPORT_LIMITATIONS[mimeType] ?? null,
              truncated ? `Content truncated to ~${MAX_CONTENT_BYTES} bytes.` : null,
            );
          }
        } else if (isTextMime(mimeType)) {
          // Bound the transfer with a Range header so an arbitrarily large
          // text-MIME file (e.g. a multi-hundred-MB .csv/.ndjson) can't be
          // buffered fully into the shared MCP process memory. We request one
          // byte past the cap so capContent can detect that the file was
          // actually larger and flag truncation. Google Drive honors Range on
          // alt=media downloads (responds 206 Partial Content).
          const resp = await withRetry(() =>
            drive.files.get(
              { fileId: file_id, alt: 'media' },
              {
                responseType: 'text',
                headers: { Range: `bytes=0-${MAX_CONTENT_BYTES}` },
              }
            )
          );
          const { content, truncated } = capContent(String(resp.data ?? ''));
          result.content = content;
          result.truncated = truncated;
          if (truncated) result.contentNote = `Content truncated to ~${MAX_CONTENT_BYTES} bytes.`;
        } else {
          result.contentNote = `Binary or unsupported type "${mimeType || 'unknown'}"; metadata only (raw bytes are not returned).`;
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result, null, 2),
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
