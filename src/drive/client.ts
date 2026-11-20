import * as fs from 'fs';
import * as path from 'path';
import { google } from 'googleapis';
import type { drive_v3 } from 'googleapis';
import type { Auth } from 'googleapis';
import { type AccountConfig, resolveAccount } from '../config.js';
import { getAuthClient } from '../gmail/auth.js';
import { mimeTypeForFilename } from '../gmail/mime.js';
import { googleApiCall } from '../google-api-error.js';
import { log } from '../log.js';
import { errorStatus, googleErrorMessage, isMissingScopeError } from '../scope-error.js';

// ---------------------------------------------------------------------------
// Client cache: Google Drive API client per account with 50-min TTL.
// Mirrors the caching idiom in src/gmail/client.ts.
//
// Everything in this module is READ-ONLY except `uploadFile`, which creates a
// new file, and `shareFile`, which gives named people access to one. Drive
// writes run under `drive.file` — the scope that grants access to files THIS
// APP creates and to nothing else in the user's Drive — so no code path here
// can update or delete a document the user already had, or change who can
// reach one.
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

/** The same thing for a Google Sheet. */
export const GOOGLE_SHEET_MIME = 'application/vnd.google-apps.spreadsheet';

/** And for Google Slides. */
export const GOOGLE_SLIDES_MIME = 'application/vnd.google-apps.presentation';

/**
 * Which Google file an upload of each source type can become.
 *
 * Keyed by the SOURCE mime type — the type of the bytes on disk — because that
 * is what `mimeTypeForFilename` produces and what the media part of the upload
 * carries. The value is the type to name in the files.create METADATA, which is
 * the whole mechanism: Drive reads the metadata as "make it this" and the media
 * as "here is what to make it from".
 *
 * The list is deliberately closed. Every entry is a format Google's own
 * `about.get({ fields: 'importFormats' })` reports as importable, and the live
 * acceptance harness checks this map against that list rather than against
 * anybody's memory. Adding a guessed entry would move the failure from that
 * check to a caller's upload, which is exactly the wrong place for it.
 */
export const CONVERT_TARGET_BY_SOURCE_MIME: Readonly<Record<string, string>> = {
  // → Google Sheets
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': GOOGLE_SHEET_MIME, // xlsx
  'application/vnd.ms-excel': GOOGLE_SHEET_MIME, // xls
  'application/vnd.oasis.opendocument.spreadsheet': GOOGLE_SHEET_MIME, // ods
  'text/csv': GOOGLE_SHEET_MIME,
  'text/tab-separated-values': GOOGLE_SHEET_MIME, // tsv
  // → Google Docs
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': GOOGLE_DOC_MIME, // docx
  'application/msword': GOOGLE_DOC_MIME, // doc
  'application/vnd.oasis.opendocument.text': GOOGLE_DOC_MIME, // odt
  'application/rtf': GOOGLE_DOC_MIME,
  'text/plain': GOOGLE_DOC_MIME, // txt
  // → Google Slides
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': GOOGLE_SLIDES_MIME, // pptx
  'application/vnd.ms-powerpoint': GOOGLE_SLIDES_MIME, // ppt
  'application/vnd.oasis.opendocument.presentation': GOOGLE_SLIDES_MIME, // odp
};

/**
 * The same set said in the vocabulary a caller actually has: file extensions.
 *
 * A refusal that named mime types would be telling someone holding
 * `budget.numbers` to go and find a `text/tab-separated-values`. The unit tests
 * check every extension here really does resolve, through
 * `mimeTypeForFilename`, into a key of the map above — so the advice cannot
 * drift away from the behaviour.
 */
export const CONVERTIBLE_EXTENSIONS: readonly string[] = [
  'xlsx', 'xls', 'ods', 'csv', 'tsv',
  'docx', 'doc', 'odt', 'rtf', 'txt',
  'pptx', 'ppt', 'odp',
];

/**
 * The Google type a file of this name would convert into, or undefined if
 * Google cannot import it.
 *
 * Takes the NAME the file will have in Drive rather than the local path: an
 * upload can be renamed on the way up, and the name it lands under is the one
 * that has to make sense of its own extension.
 */
export function convertTargetForFilename(filename: string): string | undefined {
  return CONVERT_TARGET_BY_SOURCE_MIME[mimeTypeForFilename(filename)];
}

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
  /**
   * Convert the upload into its native Google equivalent instead of storing the
   * bytes. Unset or false is the v1.9.0 path, unchanged down to the request
   * body. True with a source type Google cannot import is refused before any
   * network call rather than quietly uploaded unconverted.
   */
  convert?: boolean;
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
  /** Present, and true, only when the upload was converted to a Google file. */
  converted?: true;
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
 *
 * With `convert` set, the file lands as a real Google Sheet / Doc / Slides
 * instead of a stored Office or CSV file. A source type Google cannot import is
 * refused here, before a client is even built, because the alternative — upload
 * it unconverted and say nothing — is how somebody ends up clicking a file that
 * will not open the way they were told it would.
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

  // Decided from the resolved source type, so a rename on the way up is
  // accounted for, and refused HERE — no client, no token, no request. Asking
  // Google to convert a PDF fails at Google anyway; failing locally costs the
  // caller nothing and says what would have worked.
  const convertTo = opts.convert ? CONVERT_TARGET_BY_SOURCE_MIME[mimeType] : undefined;
  if (opts.convert && !convertTo) {
    throw new Error(
      `upload_drive_file: ${mimeType} cannot be converted into a Google file. `
      + `Google imports these: ${CONVERTIBLE_EXTENSIONS.join(', ')}. `
      + 'Upload it without convert to store the file in Drive as it is.',
    );
  }

  const drive = await getDriveClient(resolved);

  // The honesty path every other Drive/Docs tool travels. `withScopeHint`
  // rescued only a MISSING SCOPE; every other 403 fell through to withRetry's
  // rewrite — "Authentication error (403) … Re-authenticate with: npx tsx
  // src/auth.ts" — and Drive's other 403s (a folder this account cannot write
  // to, the Drive API switched off on the project, a storage quota) are none of
  // them a broken login. `googleApiCall` is `withRetry` with the translation
  // inside it, so the retry behaviour above is unchanged: the read stream is
  // still created per attempt, a 5xx is still retried, and a rate-limit 403 is
  // still passed through untouched so withRetry backs off on it.
  const response = await googleApiCall(
    {
      tool: 'upload_drive_file',
      api: 'Google Drive',
      scope: DRIVE_FILE_SCOPE,
      alias: resolved.alias,
    },
    () =>
      drive.files.create({
        requestBody: {
          name,
          ...(folderId ? { parents: [folderId] } : {}),
          // The TARGET type, and only when a conversion was asked for: with
          // `convert` unset this object is exactly what v1.9.0 sent.
          ...(convertTo ? { mimeType: convertTo } : {}),
        },
        media: {
          mimeType,
          body: fs.createReadStream(filePath),
        },
        fields: 'id,name,mimeType,size,webViewLink,webContentLink,parents',
        supportsAllDrives: true,
      }),
  );

  const file = response.data;
  // A converted Google file reports no size at all — Drive does not measure its
  // own formats in bytes. `size` below is the LOCAL stat and is named as such;
  // `driveSize` is simply absent rather than being filled in with it.
  const driveSize = file.size !== undefined && file.size !== null ? Number(file.size) : undefined;

  // Mutating path: logged like send, trash and create_calendar_event. Ids and
  // sizes only — never the local path or the file's contents.
  log('info', 'upload_drive_file', {
    account: resolved.alias,
    file_id: file.id ?? null,
    folder_id: folderId ?? null,
    bytes: stat.size,
    mime_type: mimeType,
    convert_to: convertTo ?? null,
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
    ...(convertTo ? { converted: true as const } : {}),
    account: resolved.alias,
  };
}

// ---------------------------------------------------------------------------
// Sharing with named people — share_drive_file
//
// Every piece below is shared by both permission tools (the address rule, the
// list read with paging, the "file not reachable" words and the result shape),
// so a rule tightened for one cannot drift away from the other.
// ---------------------------------------------------------------------------

/** The only roles a person can be given, or have removed, through this server. */
export const SHARE_ROLES = ['reader', 'commenter', 'writer'] as const;
export type ShareRole = (typeof SHARE_ROLES)[number];

/**
 * One plain mailbox address: one `@`, a dotted domain, and none of the
 * characters that would make it a list (`,` `;`), a display name (`<` `>` `"`
 * `(` `)`), a wildcard (`*`) or anything with a space in it.
 */
const ADDRESS_RE = /^[^\s@,;<>"()*]+@[^\s@,;<>"()*]+\.[^\s@,;<>"()*]+$/;

/** Validate one address; returns it trimmed, or throws naming the item and the rule. */
export function checkAddress(tool: string, raw: unknown, where: string): string {
  if (typeof raw !== 'string') {
    throw new Error(`${tool}: ${where} must be an email address written as text.`);
  }
  const email = raw.trim();
  if (!ADDRESS_RE.test(email)) {
    throw new Error(
      `${tool}: ${where} "${email}" is not one plain email address. Give exactly one address `
      + '(name@example.com): one @, a dotted domain, and no spaces, commas, angle brackets, '
      + 'display name or wildcard.',
    );
  }
  return email;
}

/** Refuse the same address twice, case-insensitively. */
function checkDistinct(tool: string, emails: string[]): void {
  const seen = new Map<string, number>();
  emails.forEach((email, i) => {
    const key = email.toLowerCase();
    const first = seen.get(key);
    if (first !== undefined) {
      throw new Error(
        `${tool}: recipients[${i}] "${email}" repeats recipients[${first}]; name each person once.`,
      );
    }
    seen.set(key, i);
  });
}

/** Validate a file id: trimmed, non-empty, an id rather than a link. */
export function checkFileId(tool: string, raw: unknown): string {
  const fileId = typeof raw === 'string' ? raw.trim() : '';
  if (!fileId) throw new Error(`${tool}: file_id is required.`);
  if (fileId.includes('/')) {
    throw new Error(
      `${tool}: file_id must be the Drive file id, not a link (the part after /d/ in the address).`,
    );
  }
  return fileId;
}

/** The fields every permissions read asks for. */
const PERMISSION_LIST_FIELDS = 'nextPageToken,permissions(id,type,role,emailAddress,displayName,domain,deleted)';

/** One Drive permission as Google lists it. */
export type DrivePermission = drive_v3.Schema$Permission;

/** A failed Drive call, classified on Google's raw error before the shared translator rewrote it. */
interface DriveFailure {
  /** The words to report: the shared translator's, or the "not reachable" explanation. */
  reason: string;
  /** True when no later call on this file can succeed either: a missing scope, a 401, or a file that is out of reach. */
  fileLevel: boolean;
  /** The raw HTTP status, when Google sent one. */
  status?: number;
}

/**
 * The words for a file this server's `drive.file` grant cannot reach. Google
 * answers 404 for such a file exactly as for an id that never existed, and
 * neither is a broken login.
 */
function notReachableReason(tool: string, fileId: string, alias: string, raw: unknown): string {
  return (
    `${tool}: this server cannot reach file "${fileId}" on "${alias}". It holds the narrow `
    + '"drive.file" grant, which reaches only files this server created itself (with '
    + 'upload_drive_file or create_google_doc), and only on the account that created them. A file '
    + 'made by hand in Drive, or created on another account, is invisible to it, and Google says '
    + '"not found" exactly as it would for an id that never existed. Re-authenticating will not '
    + `change this; the grant is working as designed.\n\nOriginal error: ${googleErrorMessage(raw)}`
  );
}

/**
 * Run one permissions call through `googleApiCall` (retries plus the honest
 * error path), keeping the raw Google error so the caller can tell a file-level
 * stop from one person's failure. `notFound` says what a 404 means for THIS
 * call: the file is out of reach, or only this one permission is gone.
 */
async function permissionCall<T>(
  ctx: { tool: string; alias: string; fileId: string; notFound: 'file' | 'person' },
  fn: () => Promise<T>,
): Promise<{ ok: true; value: T } | ({ ok: false } & DriveFailure)> {
  let raw: unknown;
  try {
    const value = await googleApiCall(
      { tool: ctx.tool, api: 'Google Drive', scope: DRIVE_FILE_SCOPE, alias: ctx.alias },
      async () => {
        try {
          return await fn();
        } catch (err) {
          raw = err;
          throw err;
        }
      },
    );
    return { ok: true, value };
  } catch (err) {
    const status = errorStatus(raw);
    const translated = err instanceof Error ? err.message : String(err);
    if (isMissingScopeError(raw) || status === 401) {
      return { ok: false, reason: translated, fileLevel: true, status };
    }
    if (status === 404 && ctx.notFound === 'file') {
      return { ok: false, reason: notReachableReason(ctx.tool, ctx.fileId, ctx.alias, raw), fileLevel: true, status };
    }
    return { ok: false, reason: translated, fileLevel: false, status };
  }
}

/** Read a file's whole permission list, following `nextPageToken`. */
async function listPermissions(
  drive: drive_v3.Drive,
  ctx: { tool: string; alias: string; fileId: string },
): Promise<{ ok: true; value: DrivePermission[] } | ({ ok: false } & DriveFailure)> {
  const all: DrivePermission[] = [];
  let pageToken: string | undefined;
  do {
    const token = pageToken;
    const page = await permissionCall({ ...ctx, notFound: 'file' }, () =>
      drive.permissions.list({
        fileId: ctx.fileId,
        fields: PERMISSION_LIST_FIELDS,
        pageSize: 100,
        supportsAllDrives: true,
        ...(token ? { pageToken: token } : {}),
      }),
    );
    if (!page.ok) return page;
    all.push(...(page.value.data.permissions ?? []));
    pageToken = page.value.data.nextPageToken ?? undefined;
  } while (pageToken);
  return { ok: true, value: all };
}

/** One person's outcome, in the order they were named. */
export interface PermissionResult {
  email: string;
  role?: string;
  status: 'granted' | 'removed' | 'unconfirmed' | 'failed' | 'not_found';
  permissionId?: string;
  reason?: string;
}

/** What both permission tools return. */
export interface PermissionChangeResult {
  success: boolean;
  fileId: string;
  account: string;
  results: PermissionResult[];
  /** Google's own list after the change; null when it could not be read and there is no earlier list to show. */
  permissions: DrivePermission[] | null;
  /** Present when the read-back after the change failed. */
  readBackError?: string;
  /** Present, and true, when `permissions` is the list taken BEFORE the change because the read-back failed. */
  permissionsTakenBeforeRemovals?: true;
}

export interface ShareFileOptions {
  fileId: unknown;
  recipients: unknown;
  account?: string | AccountConfig;
}

const SHARE_TOOL = 'share_drive_file';

/** Validate the share request in full before anything is sent. */
function checkShareRecipients(raw: unknown): Array<{ email: string; role: ShareRole }> {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`${SHARE_TOOL}: recipients must name at least one person.`);
  }
  const recipients = raw.map((item: unknown, i) => {
    const where = `recipients[${i}]`;
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error(`${SHARE_TOOL}: ${where} must be { email, role }.`);
    }
    const extra = Object.keys(item).filter(key => key !== 'email' && key !== 'role');
    if (extra.length > 0) {
      throw new Error(
        `${SHARE_TOOL}: ${where} carries ${extra.map(k => `"${k}"`).join(', ')}; each recipient is exactly `
        + '{ email, role }. This tool shares only with named people: never link, domain or group sharing.',
      );
    }
    const { email, role } = item as { email?: unknown; role?: unknown };
    const checkedEmail = checkAddress(SHARE_TOOL, email, `${where}.email`);
    if (typeof role !== 'string' || !(SHARE_ROLES as readonly string[]).includes(role)) {
      throw new Error(
        `${SHARE_TOOL}: ${where}.role "${String(role ?? '')}" is not allowed; the role must be reader, commenter or writer.`,
      );
    }
    return { email: checkedEmail, role: role as ShareRole };
  });
  checkDistinct(SHARE_TOOL, recipients.map(r => r.email));
  return recipients;
}

/**
 * Give named people access to a file this server created.
 *
 * Every refusal happens before a client is built. Then one `permissions.create`
 * per person, in order, always `type: "user"` with Google's notification email
 * switched OFF, then one read-back of the file's list. A person is `granted`
 * only when the read-back shows the id the create returned, at the role asked
 * for. A file-level failure (missing scope, 401, file out of reach) stops the
 * loop and fails that person and everyone after them; when it leaves nothing
 * granted it is thrown, so the tool answers with an error.
 */
export async function shareFile(opts: ShareFileOptions): Promise<PermissionChangeResult> {
  const resolved = resolve(opts.account);
  const fileId = checkFileId(SHARE_TOOL, opts.fileId);
  const recipients = checkShareRecipients(opts.recipients);

  const drive = await getDriveClient(resolved);
  const ctx = { tool: SHARE_TOOL, alias: resolved.alias, fileId };

  const results: PermissionResult[] = [];
  let stop: string | undefined;
  for (const { email, role } of recipients) {
    if (stop) {
      results.push({ email, role, status: 'failed', reason: stop });
      continue;
    }
    const outcome = await permissionCall({ ...ctx, notFound: 'file' }, () =>
      drive.permissions.create({
        fileId,
        sendNotificationEmail: false,
        supportsAllDrives: true,
        fields: 'id,type,role,emailAddress',
        requestBody: { type: 'user', role, emailAddress: email },
      }),
    );
    if (outcome.ok) {
      results.push({ email, role, status: 'granted', ...(outcome.value.data.id ? { permissionId: outcome.value.data.id } : {}) });
    } else {
      if (outcome.fileLevel) stop = outcome.reason;
      results.push({ email, role, status: 'failed', reason: outcome.reason });
    }
  }

  if (stop && !results.some(r => r.status === 'granted')) {
    throw new Error(stop);
  }

  const readBack = await listPermissions(drive, ctx);
  for (const result of results) {
    if (result.status !== 'granted') continue;
    if (!readBack.ok) {
      result.status = 'unconfirmed';
      result.reason = `The share was accepted, but the read-back of the file's permissions failed: ${readBack.reason}`;
    } else if (!result.permissionId) {
      result.status = 'unconfirmed';
      result.reason = 'Google accepted the share but returned no permission id to check the read-back against.';
    } else {
      const entry = readBack.value.find(p => p.id === result.permissionId);
      if (!entry) {
        result.status = 'unconfirmed';
        result.reason = `The read-back does not show permission ${result.permissionId}; read the file's permissions again after a moment.`;
      } else if (entry.role !== result.role) {
        result.status = 'unconfirmed';
        result.reason = `The read-back shows permission ${result.permissionId} as "${entry.role}", not the requested "${result.role}".`;
      }
    }
  }

  // Mutating path, logged like upload_drive_file: alias, file id, counts,
  // roles and permission ids. Never an address (send_email logs none either).
  log('info', SHARE_TOOL, {
    account: resolved.alias,
    file_id: fileId,
    recipients: results.length,
    granted: results.filter(r => r.status === 'granted').length,
    unconfirmed: results.filter(r => r.status === 'unconfirmed').length,
    failed: results.filter(r => r.status === 'failed').length,
    roles: results.map(r => r.role),
    permission_ids: results.map(r => r.permissionId ?? null),
    read_back: readBack.ok,
  });

  return {
    success: readBack.ok && results.every(r => r.status === 'granted'),
    fileId,
    account: resolved.alias,
    results,
    permissions: readBack.ok ? readBack.value : null,
    ...(readBack.ok ? {} : { readBackError: readBack.reason }),
  };
}
