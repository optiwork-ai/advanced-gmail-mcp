import * as fs from 'fs';
import * as path from 'path';
import { google } from 'googleapis';
import type { drive_v3 } from 'googleapis';
import type { Auth } from 'googleapis';
import { type AccountConfig, resolveAccount } from '../config.js';
import { getAuthClient } from '../gmail/auth.js';
import { withRetry } from '../gmail/client.js';
import { mimeTypeForFilename } from '../gmail/mime.js';
import { log } from '../log.js';
import { withScopeHint } from '../scope-error.js';

// ---------------------------------------------------------------------------
// Client cache: Google Drive API client per account with 50-min TTL.
// Mirrors the caching idiom in src/gmail/client.ts.
//
// Everything in this module is READ-ONLY except `uploadFile`, which creates a
// new file. Drive writes run under `drive.file` — the scope that grants access
// to files THIS APP creates and to nothing else in the user's Drive — so no
// code path here can update or delete a document the user already had.
//
// One other tool writes through this client rather than through this module:
// `create_google_doc` (src/tools/docs-create-document.ts) issues its own
// `files.create`, the same way the Drive read tools issue their own
// `files.list` / `files.get`. It is CREATE-only and rides the same
// `drive.file` scope, so the paragraph above still holds for the whole server.
// ---------------------------------------------------------------------------

interface CachedClient {
  client: Auth.OAuth2Client;
  drive: drive_v3.Drive;
  expiresAt: number;
}

const CLIENT_CACHE = new Map<string, CachedClient>();
const CLIENT_TTL_MS = 50 * 60 * 1000; // 50 minutes

/**
 * Get an authenticated Google Drive API client for an account.
 * Reuses the shared OAuth client + per-account token store via getAuthClient.
 * Caches the built client per account with a 50-min TTL.
 */
export async function getDriveClient(account?: string | AccountConfig): Promise<drive_v3.Drive> {
  const resolved = typeof account === 'string' || account === undefined
    ? resolveAccount(account)
    : account;

  const cacheKey = resolved.email;
  const cached = CLIENT_CACHE.get(cacheKey);

  if (cached && Date.now() < cached.expiresAt) {
    return cached.drive;
  }

  const authClient = await getAuthClient(resolved);
  const drive = google.drive({ version: 'v3', auth: authClient });

  CLIENT_CACHE.set(cacheKey, {
    client: authClient,
    drive,
    expiresAt: Date.now() + CLIENT_TTL_MS,
  });

  return drive;
}

/** Resolve an account input to its config record (string alias/email or object). */
function resolve(account?: string | AccountConfig): AccountConfig {
  return typeof account === 'string' || account === undefined
    ? resolveAccount(account)
    : account;
}

// ---------------------------------------------------------------------------
// Upload — the one mutating Drive operation
// ---------------------------------------------------------------------------

/** The scope an upload needs. Named here so the error message can quote it. */
export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

/** The scope a Drive search / read needs, quoted the same way. */
export const DRIVE_READONLY_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';

/**
 * Drive's own type for "this file IS a Google Doc" — as opposed to a .docx or a
 * .txt that merely sits in Drive. Naming it as the TARGET mimeType of a
 * `files.create` is what makes Drive convert the upload into a real document
 * rather than store the bytes.
 */
export const GOOGLE_DOC_MIME = 'application/vnd.google-apps.document';

/**
 * Per-file upload ceiling, decimal MB to match every other ceiling in this
 * codebase (see the mime module's `mb()`). Drive itself allows far more; the
 * limit here is about this process, which streams the file but still holds an
 * upload open inside a shared MCP server. 100MB is generous for the "save this
 * report to Drive" case and small enough that a mistyped path pointing at a
 * disk image fails fast instead of occupying the server for an hour.
 */
export const MAX_DRIVE_UPLOAD_BYTES = 100_000_000;

export interface UploadFileOptions {
  /** Absolute path to the local file. Relative paths are refused. */
  filePath: string;
  /** Optional Drive folder id to create the file in. */
  folderId?: string;
  /** Optional name override; defaults to the local file's basename. */
  name?: string;
  account?: string | AccountConfig;
}

export interface UploadFileResult {
  id: string;
  name: string;
  mimeType: string;
  /** Bytes read from disk (the local stat — always present). */
  size: number;
  /** Drive's own reported size, when it returns one. */
  driveSize?: number;
  webViewLink?: string;
  webContentLink?: string;
  folderId?: string;
  account: string;
}

/**
 * Clean a Drive file name. A name is a display string, not a path: a supplied
 * override is basenamed so it cannot smuggle a directory, and control
 * characters (CR/LF/NUL and friends) are stripped so nothing downstream has to
 * cope with them.
 */
export function driveFileName(supplied: string | undefined, filePath: string): string {
  const source = supplied && supplied.trim() ? supplied : path.basename(filePath);
  const cleaned = cleanDriveName(path.basename(source));
  return cleaned || path.basename(filePath) || 'upload';
}

/**
 * Strip what has no business in a Drive display name: control characters
 * (CR/LF/NUL and friends), plus surrounding whitespace.
 *
 * Kept separate from `driveFileName` because a document TITLE is not a
 * filename — a title may legitimately contain a slash ("Q3/Q4 planning") and
 * must not be basenamed down to "Q4 planning".
 */
export function cleanDriveName(raw: string): string {
  return raw.replace(/[\u0000-\u001f\u007f]/g, '').trim();
}

/**
 * Upload a local file to Google Drive.
 *
 * Refuses before any network call: a relative path, a path that does not
 * exist, anything that is not a regular file, and anything over
 * MAX_DRIVE_UPLOAD_BYTES. The body is a read stream created INSIDE the retried
 * call, so a retried attempt reads the file again rather than replaying a
 * consumed stream. (A 5xx retry can therefore leave two copies in Drive if the
 * first attempt actually landed — the honest trade for retrying at all, and far
 * cheaper to undo than a duplicate outbound email.)
 */
export async function uploadFile(opts: UploadFileOptions): Promise<UploadFileResult> {
  const resolved = resolve(opts.account);
  const filePath = (opts.filePath ?? '').trim();

  if (!filePath) {
    throw new Error('upload_drive_file: path is required');
  }
  if (!path.isAbsolute(filePath)) {
    throw new Error(
      `upload_drive_file: path must be absolute, got "${filePath}". `
      + 'Pass the full path, e.g. /Users/you/reports/summary.pdf',
    );
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    throw new Error(`upload_drive_file: file not found: ${filePath}`);
  }
  if (!stat.isFile()) {
    throw new Error(`upload_drive_file: not a regular file: ${filePath}`);
  }
  if (stat.size > MAX_DRIVE_UPLOAD_BYTES) {
    const size = (stat.size / 1_000_000).toFixed(1);
    const limit = (MAX_DRIVE_UPLOAD_BYTES / 1_000_000).toFixed(0);
    throw new Error(
      `upload_drive_file: ${path.basename(filePath)} is ${size}MB; the per-file limit is ${limit}MB.`,
    );
  }

  const name = driveFileName(opts.name, filePath);
  const mimeType = mimeTypeForFilename(name) === 'application/octet-stream'
    ? mimeTypeForFilename(path.basename(filePath))
    : mimeTypeForFilename(name);
  const folderId = opts.folderId?.trim() || undefined;

  const drive = await getDriveClient(resolved);

  const response = await withScopeHint(
    { tool: 'upload_drive_file', scope: DRIVE_FILE_SCOPE, alias: resolved.alias },
    () => withRetry(() =>
      drive.files.create({
        requestBody: {
          name,
          ...(folderId ? { parents: [folderId] } : {}),
        },
        media: {
          mimeType,
          body: fs.createReadStream(filePath),
        },
        fields: 'id,name,mimeType,size,webViewLink,webContentLink,parents',
        supportsAllDrives: true,
      }),
    ),
  );

  const file = response.data;
  const driveSize = file.size !== undefined && file.size !== null ? Number(file.size) : undefined;

  // Mutating path: logged like send, trash and create_calendar_event. Ids and
  // sizes only — never the local path or the file's contents.
  log('info', 'upload_drive_file', {
    account: resolved.alias,
    file_id: file.id ?? null,
    folder_id: folderId ?? null,
    bytes: stat.size,
    mime_type: mimeType,
  });

  return {
    id: file.id ?? '',
    name: file.name ?? name,
    mimeType: file.mimeType ?? mimeType,
    size: stat.size,
    ...(driveSize !== undefined && Number.isFinite(driveSize) ? { driveSize } : {}),
    ...(file.webViewLink ? { webViewLink: file.webViewLink } : {}),
    ...(file.webContentLink ? { webContentLink: file.webContentLink } : {}),
    ...(folderId ? { folderId } : {}),
    account: resolved.alias,
  };
}
