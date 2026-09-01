import { google } from 'googleapis';
import type { sheets_v4 } from 'googleapis';
import type { Auth } from 'googleapis';
import { type AccountConfig, resolveAccount } from '../config.js';
import { getAuthClient } from '../gmail/auth.js';
import { isRateLimit403 } from '../gmail/client.js';
import { errorStatus, googleErrorMessage, googleErrorReasons, isMissingScopeError } from '../scope-error.js';

// ---------------------------------------------------------------------------
// Client cache: Google Sheets API client per account with 50-min TTL.
// The sibling of src/docs/client.ts, and cached the same way.
//
// Two tools use it, and both WRITE: update_sheet_values and append_sheet_rows.
// Nothing here reads a spreadsheet — reading one goes on travelling through
// read_drive_file, which exports it as CSV under drive.readonly.
// ---------------------------------------------------------------------------

interface CachedClient {
  client: Auth.OAuth2Client;
  sheets: sheets_v4.Sheets;
  expiresAt: number;
}

const CLIENT_CACHE = new Map<string, CachedClient>();
const CLIENT_TTL_MS = 50 * 60 * 1000; // 50 minutes

/**
 * The scope the Sheets writes travel on — and it is deliberately NOT
 * `https://www.googleapis.com/auth/spreadsheets`.
 *
 * Ruled by the owner on 2026-09-01: no new OAuth scope for this. `drive.file`
 * is a grant every alias already holds, and the Sheets API honours it for
 * spreadsheets THIS SERVER created — which, now that upload_drive_file can
 * convert, is exactly the workbook the caller just put there.
 *
 * The consequence is a real boundary, not a bug: a spreadsheet made in Google
 * Sheets by hand, or uploaded by some other tool, is invisible to this server,
 * and Google reports it with the same "not found" it uses for a file that never
 * existed. `outsideAppScopeError` below exists to say that difference out loud,
 * because nothing else in the response distinguishes the two.
 *
 * Widening to the `spreadsheets` scope was DEFERRED until a real case needs
 * writing into a sheet this server did not create. That change would put every
 * alias through consent again, so it is the owner's call, not a library detail.
 */
export const SHEETS_SCOPE = 'https://www.googleapis.com/auth/drive.file';

/**
 * Get an authenticated Google Sheets API client for an account.
 * Reuses the shared OAuth client + per-account token store via getAuthClient.
 * Caches the built client per account with a 50-min TTL.
 */
export async function getSheetsClient(account?: string | AccountConfig): Promise<sheets_v4.Sheets> {
  const resolved = typeof account === 'string' || account === undefined
    ? resolveAccount(account)
    : account;

  const cacheKey = resolved.email;
  const cached = CLIENT_CACHE.get(cacheKey);

  if (cached && Date.now() < cached.expiresAt) {
    return cached.sheets;
  }

  const authClient = await getAuthClient(resolved);
  const sheets = google.sheets({ version: 'v4', auth: authClient });

  CLIENT_CACHE.set(cacheKey, {
    client: authClient,
    sheets,
    expiresAt: Date.now() + CLIENT_TTL_MS,
  });

  return sheets;
}

// ---------------------------------------------------------------------------
// What one call may carry
// ---------------------------------------------------------------------------

/**
 * Per-call ceilings. Not Google's limits — Google's are far higher — but this
 * process's: one MCP call should not occupy a shared server while it ships a
 * spreadsheet's worth of cells. A caller with more than this can send it in
 * several calls, which is why the refusal says so.
 */
export const MAX_SHEET_CELLS_PER_CALL = 10_000;
export const MAX_SHEET_ROWS_PER_CALL = 1_000;

/** What a cell may be. `null` writes a blank without deleting the cell. */
export type SheetCell = string | number | boolean | null;

export interface ValuesPayloadSize {
  rows: number;
  cells: number;
}

/**
 * Refuse a payload that is empty or too big, and measure the one that is fine.
 *
 * Pure, and called before a client is built, so all three refusals cost nothing
 * and reach the caller as advice rather than as a Google error. The empty case
 * is refused rather than sent because an empty write succeeds at Google and
 * changes nothing, and the caller would be told the sheet had been updated.
 */
export function checkValuesPayload(tool: string, values: SheetCell[][]): ValuesPayloadSize {
  const rows = values.length;
  if (rows === 0) {
    throw new Error(
      `${tool}: values is empty — pass at least one row. A call with no rows succeeds at `
      + 'Google and changes nothing, which would be reported back as a write that happened.',
    );
  }
  if (rows > MAX_SHEET_ROWS_PER_CALL) {
    throw new Error(
      `${tool}: ${rows.toLocaleString('en-US')} rows in one call; the limit is `
      + `${MAX_SHEET_ROWS_PER_CALL.toLocaleString('en-US')} rows. Send it as several smaller `
      + 'calls — one long call would hold this shared server open for everyone else.',
    );
  }

  const cells = values.reduce((total, row) => total + row.length, 0);
  if (cells > MAX_SHEET_CELLS_PER_CALL) {
    throw new Error(
      `${tool}: ${cells.toLocaleString('en-US')} cells in one call; the limit is `
      + `${MAX_SHEET_CELLS_PER_CALL.toLocaleString('en-US')} cells. Send it as several smaller `
      + 'calls — one long call would hold this shared server open for everyone else.',
    );
  }

  return { rows, cells };
}

/** The two ways a caller can have their values interpreted. */
export type ValueInputOption = 'raw' | 'user_entered';

/**
 * Google's spelling of the same thing. USER_ENTERED is the default everywhere
 * here: it is what typing into the sheet does, so "=SUM(A1:A2)" becomes a
 * formula and "5%" becomes a percentage rather than two pieces of text.
 */
export function googleValueInputOption(option?: ValueInputOption): 'RAW' | 'USER_ENTERED' {
  return option === 'raw' ? 'RAW' : 'USER_ENTERED';
}

// ---------------------------------------------------------------------------
// The failure this design has to explain for itself
// ---------------------------------------------------------------------------

/**
 * Is this Google failure "the spreadsheet is outside what drive.file can see"?
 *
 * Under `drive.file` a spreadsheet the app did not create is not merely
 * forbidden — it is INVISIBLE, and Google says 404 exactly as it would for an
 * id that never existed. A 403 on the file (rather than on the project or the
 * token) means the same thing from the other direction. Both deserve the same
 * explanation, and neither is a broken login.
 *
 * Everything else is deliberately left alone so the shared translator can do
 * its job: a missing scope still names the scope and the re-consent command, a
 * disabled API still says to switch it on in the console, a rate-limit 403 is
 * still retried, and a 401 still reaches the re-authenticate path where
 * re-authenticating IS the fix.
 */
function isOutsideAppScope(err: unknown): boolean {
  const status = errorStatus(err);
  if (status === 404) return true;
  if (status !== 403) return false;
  if (isMissingScopeError(err)) return false;
  if (isRateLimit403(status, err)) return false;
  return !googleErrorReasons(err).includes('accessnotconfigured');
}

/**
 * The replacement error for that case, or undefined when the failure is one of
 * the shared translator's.
 *
 * Returned rather than thrown, and carrying no status code, so a caller can
 * hand it onward without the shared translator rewriting it a second time.
 */
export function outsideAppScopeError(
  err: unknown,
  ctx: { tool: string; spreadsheetId: string },
): Error | undefined {
  if (!isOutsideAppScope(err)) return undefined;

  return new Error(
    `${ctx.tool}: this server cannot reach spreadsheet "${ctx.spreadsheetId}". It holds the `
    + 'narrow "drive.file" grant, which reaches only files this server created itself — so a '
    + 'spreadsheet made in Google Sheets by hand, or uploaded by another tool, is invisible to '
    + 'it and Google answers as it would for a file that does not exist. To write into that '
    + 'data, upload the workbook with upload_drive_file using convert:true and write to the '
    + 'Google Sheet that creates. Re-authenticating will not change this — the grant is '
    + `working as designed.\n\nOriginal error: ${googleErrorMessage(err)}`,
  );
}
