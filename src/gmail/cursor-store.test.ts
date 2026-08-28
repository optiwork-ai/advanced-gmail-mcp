/**
 * G12 — the mail watcher remembers where it got to.
 *
 * Until now the caller owned the cursor between polls, so a session that forgot
 * it started blind. The server now keeps the last COMPLETE position per account
 * on disk. Three rules matter more than the storing itself: it only moves
 * forward, only a complete read is stored, and a supplied cursor still wins.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-mcp-cursors-'));
process.env.GMAIL_MCP_CURSOR_DIR = DIR;

const { cursorFilePath, readCursor, writeCursor } = await import('./cursor-store.js');

beforeEach(() => {
  for (const file of fs.readdirSync(DIR)) fs.rmSync(path.join(DIR, file), { force: true });
});

afterAll(() => {
  fs.rmSync(DIR, { recursive: true, force: true });
});

describe('readCursor', () => {
  it('is null before anything has been remembered', () => {
    expect(readCursor('work')).toBeNull();
  });

  it('reads back what was written', () => {
    writeCursor('work', '12345');
    expect(readCursor('work')).toBe('12345');
  });

  it('keeps accounts apart', () => {
    writeCursor('work', '100');
    writeCursor('personal', '200');
    expect(readCursor('work')).toBe('100');
    expect(readCursor('personal')).toBe('200');
  });

  it('treats a corrupt file as "nothing remembered" rather than throwing', () => {
    fs.writeFileSync(path.join(DIR, 'work.json'), 'not json at all');
    expect(readCursor('work')).toBeNull();
  });

  it('refuses a stored value that is not a history id', () => {
    fs.writeFileSync(path.join(DIR, 'work.json'), JSON.stringify({ historyId: 'abc' }));
    expect(readCursor('work')).toBeNull();
  });
});

describe('writeCursor', () => {
  it('moves forward', () => {
    writeCursor('work', '100');
    expect(writeCursor('work', '200')).toEqual({ stored: true });
    expect(readCursor('work')).toBe('200');
  });

  it('REFUSES to rewind, because a rewind replays mail as if it were new', () => {
    writeCursor('work', '200');
    const outcome = writeCursor('work', '100');

    expect(outcome.stored).toBe(false);
    expect(outcome.reason).toMatch(/rewind/i);
    expect(readCursor('work')).toBe('200');
  });

  it('accepts the same position again', () => {
    writeCursor('work', '200');
    expect(writeCursor('work', '200').stored).toBe(true);
  });

  it('compares as a number, not as a string — 1000 is ahead of 999', () => {
    writeCursor('work', '999');
    expect(writeCursor('work', '1000').stored).toBe(true);
    expect(readCursor('work')).toBe('1000');
  });

  it('handles a history id past 2^53 without losing precision', () => {
    const big = '9007199254740993';
    writeCursor('work', big);
    expect(readCursor('work')).toBe(big);
    expect(writeCursor('work', '9007199254740992').stored).toBe(false);
  });

  it('rejects a value that is not a history id', () => {
    expect(writeCursor('work', 'abc').stored).toBe(false);
    expect(readCursor('work')).toBeNull();
  });

  it('cannot be made to write outside its directory by a hostile alias', () => {
    writeCursor('../escape', '100');
    expect(fs.existsSync(path.join(DIR, '..', 'escape.json'))).toBe(false);
    expect(fs.readdirSync(DIR)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// P5 — the bookmark is per account AND per filter.
//
// It used to be keyed on the alias alone, while get_mail_changes also takes
// label_id and history_types. So an INBOX-only agent and an unfiltered watcher
// polling the same account shared one bookmark and silently ate each other's
// window: whichever polled first moved the cursor past everything, and the
// other was told nothing had happened. Neither could tell.
// ---------------------------------------------------------------------------

describe('a filtered poll keeps its own bookmark', () => {
  it('an UNFILTERED poll still uses the plain per-alias file, so existing cursors keep working', () => {
    fs.writeFileSync(
      path.join(DIR, 'steve-optiwork.json'),
      JSON.stringify({ alias: 'steve-optiwork', historyId: '4242' }),
    );

    expect(readCursor('steve-optiwork')).toBe('4242');
    expect(readCursor('steve-optiwork', {})).toBe('4242');
  });

  it('two callers with different filters no longer consume each other\'s window', () => {
    writeCursor('work', '5000', { labelId: 'INBOX' });
    writeCursor('work', '9000');

    expect(readCursor('work', { labelId: 'INBOX' })).toBe('5000');
    expect(readCursor('work')).toBe('9000');
  });

  it('a filtered bookmark is written somewhere else entirely, not over the plain one', () => {
    writeCursor('work', '5000');
    writeCursor('work', '6000', { labelId: 'INBOX' });

    expect(readCursor('work')).toBe('5000');
    expect(fs.readdirSync(DIR)).toHaveLength(2);
  });

  it('the same filter resolves to the same file however it was ordered', () => {
    writeCursor('work', '7000', { historyTypes: ['labelAdded', 'messageAdded'] });

    expect(readCursor('work', { historyTypes: ['messageAdded', 'labelAdded'] })).toBe('7000');
  });

  it('different filters on one account do not collide', () => {
    writeCursor('work', '100', { labelId: 'INBOX' });
    writeCursor('work', '200', { labelId: 'SENT' });
    writeCursor('work', '300', { labelId: 'INBOX', historyTypes: ['messageAdded'] });

    expect(readCursor('work', { labelId: 'INBOX' })).toBe('100');
    expect(readCursor('work', { labelId: 'SENT' })).toBe('200');
    expect(readCursor('work', { labelId: 'INBOX', historyTypes: ['messageAdded'] })).toBe('300');
  });

  it('two aliases that sanitize to the same filename keep separate filtered bookmarks', () => {
    writeCursor('a/b', '100', { labelId: 'INBOX' });
    writeCursor('a_b', '200', { labelId: 'INBOX' });

    expect(readCursor('a/b', { labelId: 'INBOX' })).toBe('100');
    expect(readCursor('a_b', { labelId: 'INBOX' })).toBe('200');
  });

  it('a filtered alias still cannot write outside the cursor directory', () => {
    writeCursor('../escape', '100', { labelId: 'INBOX' });

    expect(fs.existsSync(path.join(DIR, '..', 'escape.json'))).toBe(false);
    expect(fs.readdirSync(DIR)).toHaveLength(1);
  });

  it('names the file it actually uses, so a wedged filtered cursor can be cleared', () => {
    const plain = cursorFilePath('work');
    const filtered = cursorFilePath('work', { labelId: 'INBOX' });

    expect(filtered).not.toBe(plain);
    expect(path.dirname(filtered)).toBe(DIR);

    writeCursor('work', '100', { labelId: 'INBOX' });
    expect(fs.existsSync(filtered)).toBe(true);
  });

  it('the rewind rule is per filter, not shared across them', () => {
    writeCursor('work', '9000');
    expect(writeCursor('work', '100', { labelId: 'INBOX' }).stored).toBe(true);
    expect(readCursor('work', { labelId: 'INBOX' })).toBe('100');
  });
});
