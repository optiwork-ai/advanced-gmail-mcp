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

const { readCursor, writeCursor } = await import('./cursor-store.js');

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
