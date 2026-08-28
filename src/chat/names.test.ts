/**
 * G10 — the two Chat tools accepted different id formats from each other.
 *
 * list_chat_messages took a bare space id ("AAAA") or a full resource name;
 * get_chat_message took only the full "spaces/A/messages/B". Passing the same
 * id the sibling had just accepted failed with a raw Google error.
 */
import { describe, expect, it } from 'vitest';
import { toMessageName, toSpaceParent } from './names.js';

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
