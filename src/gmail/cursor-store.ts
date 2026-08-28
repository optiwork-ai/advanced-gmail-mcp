import * as crypto from 'crypto';
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
 * - **A bookmark belongs to an account AND to a filter.** `get_mail_changes`
 *   also takes `label_id` and `history_types`, and a poll only ever sees the
 *   changes its filter admits. Keyed on the alias alone, an INBOX-only agent
 *   and an unfiltered watcher on one account shared a bookmark and silently ate
 *   each other's window: whichever polled first moved the cursor past
 *   everything, and the other was told nothing had happened. Each distinct
 *   filter now gets its own file.
 *
 * The files live beside `tokens/` and are gitignored, for the same reason: they
 * are per-machine, per-account state, not source.
 */

/**
 * What narrowed a poll. An absent or empty field means "not narrowed by this".
 * An EMPTY filter is the unfiltered case and is treated as no filter at all.
 */
export interface CursorFilter {
  /** The single label the poll was restricted to, e.g. INBOX. */
  labelId?: string;
  /** The change kinds the poll was restricted to. Order is not significant. */
  historyTypes?: readonly string[];
}

/**
 * The canonical text of a filter, or null when there is no filter.
 *
 * Order-independent, because ["labelAdded","messageAdded"] and
 * ["messageAdded","labelAdded"] ask Gmail for exactly the same thing and must
 * not end up with two bookmarks. An explicit list of ALL four types is still a
 * filter here: the signature records what the caller asked for, not what it
 * happens to be equivalent to.
 */
function filterSignature(filter?: CursorFilter): string | null {
  const labelId = filter?.labelId?.trim() || null;
  const types = [...(filter?.historyTypes ?? [])].filter(t => t.length > 0).sort();
  if (labelId === null && types.length === 0) return null;
  return JSON.stringify({ labelId, historyTypes: types });
}

function cursorPath(alias: string, filter?: CursorFilter): string {
  // The alias comes from accounts.json, but here it becomes a filename, so it
  // is sanitized rather than trusted: an alias containing a slash must not be
  // able to write outside the cursor directory.
  const safe = alias.replace(/[^A-Za-z0-9._-]/g, '_');

  const signature = filterSignature(filter);
  // An UNFILTERED poll keeps exactly the filename it has always had, so every
  // cursor already on disk keeps working and no watcher restarts blind.
  if (signature === null) return path.join(getCursorDir(), `${safe}.json`);

  // A filtered poll gets its own file under a deterministic suffix. The hash
  // covers the UNSANITIZED alias as well as the filter, so it is collision-free
  // in both directions: two filters on one account cannot share a file, and
  // neither can two aliases that sanitize to the same name ("a/b" and "a_b").
  const digest = crypto
    .createHash('sha256')
    .update(`${alias}\u0000${signature}`)
    .digest('hex')
    .slice(0, 16);
  return path.join(getCursorDir(), `${safe}--${digest}.json`);
}

/**
 * Where a remembered cursor lives on disk.
 *
 * Exported so a caller that has PROVED the stored cursor does not belong to
 * this mailbox can name the file to delete. The directory is configurable, the
 * alias is sanitized into the filename and a filtered poll's file carries a
 * hashed suffix, so the path cannot be reconstructed correctly by a caller
 * guessing at the layout. Pass the SAME filter the poll used, or the answer
 * names a different file.
 */
export function cursorFilePath(alias: string, filter?: CursorFilter): string {
  return cursorPath(alias, filter);
}

interface StoredCursor {
  alias: string;
  historyId: string;
  updatedAt: string;
  /**
   * The filter this bookmark belongs to, recorded so the file says what it is
   * for. Absent on an unfiltered bookmark. Never read back — the filename is
   * what identifies the file — so an old file without it still loads.
   */
  filter?: unknown;
}

/** The remembered cursor for an account and filter, or null if there is not one yet. */
export function readCursor(alias: string, filter?: CursorFilter): string | null {
  try {
    const file = cursorPath(alias, filter);
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
export function writeCursor(
  alias: string,
  historyId: string,
  filter?: CursorFilter,
): { stored: boolean; reason?: string } {
  if (!/^\d+$/.test(historyId)) {
    return { stored: false, reason: 'is not a history id' };
  }

  // Per filter, like the storing itself: one filter's position says nothing
  // about whether another filter's position would be a rewind.
  const existing = readCursor(alias, filter);
  if (existing !== null && BigInt(historyId) < BigInt(existing)) {
    return { stored: false, reason: `would rewind the remembered cursor from ${existing}` };
  }

  try {
    const file = cursorPath(alias, filter);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const signature = filterSignature(filter);
    const body: StoredCursor = {
      alias,
      historyId,
      updatedAt: new Date().toISOString(),
      ...(signature !== null ? { filter: JSON.parse(signature) } : {}),
    };
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
