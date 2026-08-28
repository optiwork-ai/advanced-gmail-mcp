import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DRIVE_FILE_SCOPE, GOOGLE_DOC_MIME, cleanDriveName, getDriveClient } from '../drive/client.js';
import { type AccountConfig, resolveAccount } from '../config.js';
import { googleApiCall } from '../google-api-error.js';
import { log } from '../log.js';

/**
 * CF1 — the CREATION half of "Docs write".
 *
 * `update_google_doc` (G11) can edit a document that already exists; until this
 * tool there was no way to make one, so "write that up as a doc" had nowhere to
 * land.
 *
 * Creation deliberately does NOT go through the Docs API. `documents.create`
 * takes a title and nothing else — putting text in would mean a second,
 * index-addressed call — and it needs the `documents` scope, which no alias has
 * consented to yet. Drive's `files.create` does the whole job in one request:
 * name the TARGET mimeType as a Google Doc, hand it the text as `text/plain`,
 * and Google converts on upload. That path rides `drive.file`, which every
 * alias already granted on 2026-08-27, so this tool works today with no consent
 * round.
 *
 * `drive.file` also bounds the blast radius exactly right: it reaches only
 * files this server created, so nothing here can touch a document the user
 * already had.
 *
 * The request is built here rather than in `src/drive/client.ts` for the same
 * reason the Drive read tools build theirs there — one place per tool, and the
 * client module stays the connection, not the catalogue.
 */

export interface CreateDocOptions {
  /** The document's title. Required; empty or whitespace is refused. */
  title: string;
  /** Plain text for the body. Omit for an empty document. */
  initialText?: string;
  /** Drive folder id to create it in. Omit for the account's My Drive root. */
  folderId?: string;
  account?: string | AccountConfig;
}

export interface CreateDocResult {
  documentId: string;
  title: string;
  mimeType: string;
  webViewLink?: string;
  folderId?: string;
  account: string;
}

/**
 * Create a Google Doc in the account's Drive, optionally with a body.
 *
 * The one refusal that happens before any network call is an empty title: an
 * untitled document is a real thing in Drive but an unfindable one, and a model
 * that omitted the title almost always meant to pass one.
 *
 * NOT retried. `files.create` is not idempotent — a retry after a request that
 * actually landed leaves two documents and returns the id of only one, so the
 * caller edits one copy and the user reads the other. A failure here is
 * reported and the caller can decide, which is the same trade the outbound-mail
 * paths make.
 */
export async function createGoogleDoc(opts: CreateDocOptions): Promise<CreateDocResult> {
  const resolved = typeof opts.account === 'string' || opts.account === undefined
    ? resolveAccount(opts.account)
    : opts.account;

  const title = cleanDriveName(opts.title ?? '');
  if (!title) {
    throw new Error(
      'create_google_doc: title is required — a document with no title is filed in Drive as '
      + '"Untitled document" and is effectively unfindable afterwards.',
    );
  }

  const initialText = opts.initialText ?? '';
  const folderId = opts.folderId?.trim() || undefined;

  const drive = await getDriveClient(resolved);
  const ctx = {
    tool: 'create_google_doc',
    api: 'Google Drive',
    scope: DRIVE_FILE_SCOPE,
    alias: resolved.alias,
  };

  const fields = {
    account: resolved.alias,
    folder_id: folderId ?? null,
    body_chars: initialText.length,
  };
  log('info', 'create_google_doc', { ...fields, phase: 'start' });

  let response;
  try {
    response = await googleApiCall(ctx, () =>
      drive.files.create({
        requestBody: {
          name: title,
          // The target type. This is what turns the upload into a document
          // rather than a text file sitting in Drive.
          mimeType: GOOGLE_DOC_MIME,
          ...(folderId ? { parents: [folderId] } : {}),
        },
        // No text means no media part at all: a metadata-only create makes an
        // empty document, whereas uploading zero bytes as text/plain asks
        // Google to convert nothing.
        ...(initialText.length > 0
          ? { media: { mimeType: 'text/plain', body: initialText } }
          : {}),
        fields: 'id,name,mimeType,webViewLink,parents',
        supportsAllDrives: true,
      }),
    );
  } catch (err: unknown) {
    log('error', 'create_google_doc', {
      ...fields,
      phase: 'failed',
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  const file = response.data;
  log('info', 'create_google_doc', { ...fields, phase: 'done', file_id: file.id ?? null });

  return {
    documentId: file.id ?? '',
    title: file.name ?? title,
    mimeType: file.mimeType ?? GOOGLE_DOC_MIME,
    ...(file.webViewLink ? { webViewLink: file.webViewLink } : {}),
    ...(folderId ? { folderId } : {}),
    account: resolved.alias,
  };
}

export const createGoogleDocParams = {
  title: z.string().describe('The document\'s title, as it will read in Drive. Required — an empty or whitespace-only title is refused rather than filed as "Untitled document".'),
  initial_text: z
    .string()
    .optional()
    .describe(
      'Plain text for the body, converted by Google on upload. Include your own newlines; '
      + 'blank lines separate paragraphs. This is PLAIN TEXT, not Markdown or HTML — "# Heading" '
      + 'arrives as the literal characters "# Heading", not as a styled heading. Omit for an '
      + 'empty document.',
    ),
  folder_id: z
    .string()
    .optional()
    .describe(
      'Drive folder id to create the document in. Omit for the account\'s My Drive root. '
      + 'Because this server holds the narrow "drive.file" scope, a folder it did not itself '
      + 'create may not be reachable — if a folder id errors, create at the root and move the '
      + 'document in Drive.',
    ),
  account: z.string().optional().describe('Account alias or email address. Uses default account if not specified.'),
};

/**
 * WRITE: create a new Google Doc.
 */
export function registerCreateGoogleDoc(server: McpServer): void {
  server.tool(
    'create_google_doc',
    'Creates a real document in the account\'s Google Drive and returns its id and link. '
    + 'The document exists the moment this returns — it is not a draft or a preview. '
    + 'Pass initial_text to give it a body; it is PLAIN TEXT that Google converts on upload, so '
    + 'Markdown syntax arrives as literal characters rather than formatting. '
    + 'Afterwards, update_google_doc can append more text or replace text you name, and '
    + 'get_google_doc can read it back. '
    + 'Uses the "drive.file" scope this server was ALREADY granted on 2026-08-27 — no new scope '
    + 'and no re-consent, unlike update_google_doc. That scope also means the server can only '
    + 'ever reach documents it created itself. '
    + 'A 403 here means that grant is missing on this account (re-consent with '
    + '"npm run auth -- <alias>"), not that the login is broken.',
    createGoogleDocParams,
    async ({ title, initial_text, folder_id, account }) => {
      try {
        const result = await createGoogleDoc({
          title,
          initialText: initial_text ?? undefined,
          folderId: folder_id ?? undefined,
          account: account ?? undefined,
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  success: true,
                  ...result,
                  hint: 'Add to or edit this document with update_google_doc (append text, or '
                    + 'replace text you name); read it back with get_google_doc.',
                },
                null,
                2,
              ),
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
