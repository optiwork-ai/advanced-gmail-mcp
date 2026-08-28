import * as fs from 'fs';
import * as path from 'path';
import { getCursorDir } from '../config.js';
import { log } from '../log.js';

/**
 * Where the mail watcher remembers where it got to, per account.
 *
 * Until now the watcher kept no state at all: the caller held the cursor
 * between polls, so a session that forgot it started blind, and every agent or
 * scheduled job wanting "what arrived since last time" had to do its own
 * bookkeeping. The server now remembers the last COMPLETE position per account,
 * so "what's new?" is one call with nothing to carry.
 *
 * Design rules, all of them load-bearing:
 *
 * - **The store only ever moves forward.** A write that would rewind the stored
 *   cursor is refused. Rewinding replays a window that was already reported,
 *   which reads as the same mail arriving twice.
 * - **Only a COMPLETE read is stored.** Gmail's response carries the mailbox's
 *   current position, not the end of the page, so storing mid-pagination would
 *   skip everything not yet read. That trap is already documented in the tool;
 *   storing only on completion makes it impossible to fall into.
 * - **It is best-effort, and never breaks a call.** A store that cannot be
 *   written is a lost convenience, not a failed poll — the same contract the
 *   log has.
 * - **An explicitly supplied cursor still wins.** Remembering is a default, not
 *   a lock: a caller who names a position gets that position.
 *
 * The files live beside `tokens/` and are gitignored, for the same reason: they
 * are per-machine, per-account state, not source.
 */

function cursorPath(alias: string): string {
  // The alias comes from accounts.json, but here it becomes a filename, so it
  // is sanitized rather than trusted: an alias containing a slash must not be
  // able to write outside the cursor directory.
  const safe = alias.replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(getCursorDir(), `${safe}.json`);
}

/**
 * Where an account's remembered cursor lives on disk.
 *
 * Exported so a caller that has PROVED the stored cursor does not belong to
 * this mailbox can name the file to delete. The directory is configurable and
 * the alias is sanitized into the filename, so the path cannot be reconstructed
 * correctly by a caller guessing at the layout.
 */
export function cursorFilePath(alias: string): string {
  return cursorPath(alias);
}

interface StoredCursor {
  alias: string;
  historyId: string;
  updatedAt: string;
}

/** The remembered cursor for an account, or null if there is not one yet. */
export function readCursor(alias: string): string | null {
  try {
    const file = cursorPath(alias);
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as StoredCursor;
    const value = String(parsed?.historyId ?? '');
    return /^\d+$/.test(value) ? value : null;
  } catch {
    // A corrupt or unreadable cursor file means "nothing remembered", never a
    // failed call.
    return null;
  }
}

/**
 * Remember a position, if it is at or ahead of what is already remembered.
 *
 * Returns what happened, so the caller can say plainly whether the bookmark
 * moved rather than assuming it did.
 */
export function writeCursor(alias: string, historyId: string): { stored: boolean; reason?: string } {
  if (!/^\d+$/.test(historyId)) {
    return { stored: false, reason: 'is not a history id' };
  }

  const existing = readCursor(alias);
  if (existing !== null && BigInt(historyId) < BigInt(existing)) {
    return { stored: false, reason: `would rewind the remembered cursor from ${existing}` };
  }

  try {
    const file = cursorPath(alias);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const body: StoredCursor = { alias, historyId, updatedAt: new Date().toISOString() };
    fs.writeFileSync(file, JSON.stringify(body, null, 2));
    return { stored: true };
  } catch (err) {
    // Best-effort: losing the bookmark must never fail the poll that produced it.
    log('warn', 'cursor_store_write_failed', {
      account: alias,
      error: err instanceof Error ? err.message : String(err),
    });
    return { stored: false, reason: 'could not be written' };
  }
}
