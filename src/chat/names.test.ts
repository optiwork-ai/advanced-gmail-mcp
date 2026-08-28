/**
 * G10 — the two Chat tools accepted different id formats from each other.
 *
 * list_chat_messages took a bare space id ("AAAA") or a full resource name;
 * get_chat_message took only the full "spaces/A/messages/B". Passing the same
 * id the sibling had just accepted failed with a raw Google error.
 */
import { describe, expect, it } from 'vitest';
import { toMessageName, toSpaceParent, toThreadTarget } from './names.js';

describe('toSpaceParent', () => {
  it('accepts a full resource name', () => {
    expect(toSpaceParent('spaces/AAAA')).toBe('spaces/AAAA');
  });

  it('accepts a bare space id', () => {
    expect(toSpaceParent('AAAA')).toBe('spaces/AAAA');
  });

  it('trims surrounding whitespace', () => {
    expect(toSpaceParent('  AAAA  ')).toBe('spaces/AAAA');
  });

  it('refuses an empty value rather than building "spaces/"', () => {
    expect(() => toSpaceParent('   ')).toThrow(/space/i);
  });
});

describe('toMessageName', () => {
  it('accepts the full resource name', () => {
    expect(toMessageName('spaces/AAAA/messages/BBBB')).toBe('spaces/AAAA/messages/BBBB');
  });

  it('accepts the same shape without the "spaces/" prefix, as its sibling does', () => {
    expect(toMessageName('AAAA/messages/BBBB')).toBe('spaces/AAAA/messages/BBBB');
  });

  it('trims surrounding whitespace', () => {
    expect(toMessageName(' spaces/AAAA/messages/BBBB ')).toBe('spaces/AAAA/messages/BBBB');
  });

  it('explains itself when given a bare message id, instead of failing at Google', () => {
    expect(() => toMessageName('BBBB')).toThrow(/space/i);
    expect(() => toMessageName('BBBB')).toThrow(/spaces\/\{space\}\/messages\/\{message\}/);
  });

  it('refuses an empty value', () => {
    expect(() => toMessageName('  ')).toThrow(/message/i);
  });
});

/**
 * CP2 — the thread a reply is aimed at. A caller usually has a MESSAGE in hand,
 * not a thread, and the two ids differ, so the kind is reported back rather
 * than guessed at with string surgery.
 */
describe('toThreadTarget', () => {
  it('takes a full thread name as it stands', () => {
    expect(toThreadTarget('spaces/AAAA', 'spaces/AAAA/threads/TTTT'))
      .toEqual({ kind: 'thread', name: 'spaces/AAAA/threads/TTTT' });
  });

  it('completes a bare thread id with the space being posted to', () => {
    expect(toThreadTarget('spaces/AAAA', 'TTTT'))
      .toEqual({ kind: 'thread', name: 'spaces/AAAA/threads/TTTT' });
    expect(toThreadTarget('spaces/AAAA', 'threads/TTTT'))
      .toEqual({ kind: 'thread', name: 'spaces/AAAA/threads/TTTT' });
  });

  it('reports a message name as a MESSAGE, for the caller to look the thread up', () => {
    expect(toThreadTarget('spaces/AAAA', 'spaces/AAAA/messages/MMMM'))
      .toEqual({ kind: 'message', name: 'spaces/AAAA/messages/MMMM' });
    expect(toThreadTarget('spaces/AAAA', 'messages/MMMM'))
      .toEqual({ kind: 'message', name: 'spaces/AAAA/messages/MMMM' });
  });

  it('refuses a name from a different space rather than re-pointing it', () => {
    expect(() => toThreadTarget('spaces/AAAA', 'spaces/BBBB/threads/TTTT'))
      .toThrow(/different Chat space/);
    expect(() => toThreadTarget('spaces/AAAA', 'spaces/BBBB/messages/MMMM'))
      .toThrow(/different Chat space/);
  });

  it('refuses an empty value', () => {
    expect(() => toThreadTarget('spaces/AAAA', '  ')).toThrow(/thread/i);
  });

  it('ignores surrounding whitespace', () => {
    expect(toThreadTarget('spaces/AAAA', ' spaces/AAAA/threads/TTTT '))
      .toEqual({ kind: 'thread', name: 'spaces/AAAA/threads/TTTT' });
  });
});
