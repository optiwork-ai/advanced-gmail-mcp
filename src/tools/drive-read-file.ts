import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getDriveClient } from '../drive/client.js';
import { withRetry } from '../gmail/client.js';

export const readDriveFileParams = {
  file_id: z.string().describe('The Drive file id to read.'),
  account: z.string().optional().describe('Account alias or email address. Uses default account if not specified.'),
};

// ~1MB cap on returned text content. Larger content is truncated with a note.
export const MAX_CONTENT_BYTES = 1_000_000;

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
 * How many bytes at the end of `buf` are an INCOMPLETE UTF-8 sequence.
 *
 * Cutting a buffer at a byte offset can land in the middle of a character.
 * Decoding that tail yields U+FFFD — a replacement glyph in the middle of the
 * user's document, which reads as corruption rather than as a cut. Dropping the
 * partial bytes instead loses at most one character and never invents one.
 */
function incompleteTailBytes(buf: Buffer): number {
  // A continuation byte is 10xxxxxx; a lead byte says how long the sequence is.
  for (let back = 1; back <= 3 && back <= buf.length; back++) {
    const byte = buf[buf.length - back];
    if ((byte & 0b1100_0000) !== 0b1000_0000) {
      // This is a lead byte (or ASCII). How long a sequence does it start?
      const needed = byte < 0x80 ? 1 : byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
      return needed > back ? back : 0;
    }
  }
  return 0;
}

/**
 * Cap a buffer at `maxBytes`, decoding what fits. The one place both read paths
 * cut, so the export branch and the alt=media branch cannot disagree about what
 * a truncated document looks like.
 *
 * Exported for unit testing.
 */
export function capBuffer(buf: Buffer, maxBytes: number): { content: string; truncated: boolean } {
  if (buf.length <= maxBytes) return { content: buf.toString('utf-8'), truncated: false };
  const sliced = buf.subarray(0, maxBytes);
  const whole = sliced.subarray(0, sliced.length - incompleteTailBytes(sliced));
  return { content: whole.toString('utf-8'), truncated: true };
}

/**
 * Cap a string at MAX_CONTENT_BYTES, returning [content, truncated].
 */
function capContent(text: string): { content: string; truncated: boolean } {
  return capBuffer(Buffer.from(text, 'utf-8'), MAX_CONTENT_BYTES);
}

/**
 * Read a response stream, stopping as soon as `maxBytes` have arrived.
 *
 * Drive's export endpoint ignores the Range header, so the export branch used
 * to await the whole body and cap it afterwards — a 50MB exported Doc or Sheet
 * was held in memory in full before being trimmed to 1MB, inside an MCP process
 * that every account shares. Reading the stream and abandoning it at the cap
 * bounds that, so one very large file can no longer disturb everything else.
 * Nothing changes for a normal-sized document.
 *
 * The stream is destroyed once we have enough, which ends the transfer rather
 * than letting the rest arrive into a listener nobody is reading.
 *
 * Exported for unit testing.
 */
export async function readStreamToCap(
  stream: NodeJS.ReadableStream,
  maxBytes: number,
): Promise<{ content: string; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let total = 0;

  try {
    for await (const chunk of stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf-8');
      chunks.push(buf);
      total += buf.length;
      // One byte past the cap is enough to know the document was longer.
      if (total > maxBytes) break;
    }
  } finally {
    // Whether we stopped early or read to the end, do not leave the transfer
    // open. `destroy` on an already-ended stream is a no-op.
    (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
  }

  return capBuffer(Buffer.concat(chunks), maxBytes);
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
            // Drive's export endpoint does not honour Range, so the transfer
            // cannot be bounded by asking for fewer bytes. It is bounded by
            // reading instead: the body arrives as a stream and the read stops
            // at the cap, so a 50MB exported Doc no longer lands whole in a
            // process every account shares.
            const resp = await withRetry(() =>
              drive.files.export(
                { fileId: file_id, mimeType: exportMime },
                { responseType: 'stream' }
              )
            );
            const { content, truncated } = await readStreamToCap(
              resp.data as unknown as NodeJS.ReadableStream,
              MAX_CONTENT_BYTES,
            );
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
