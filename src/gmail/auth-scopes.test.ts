/**
 * CP1 — the consent URL must ASK for everything the tools call.
 *
 * A scope that is missing from this list cannot be granted by any amount of
 * re-consenting: `npm run auth -- <alias>` builds its URL from exactly this
 * array, so a tool whose scope is absent 403s forever and the honest
 * scope-error message tells the reader to run a command that cannot help.
 * These pin the list against that silent failure — the Chat POSTING scope in
 * particular, added 2026-08-28 when the read-only Chat posture was withdrawn.
 */
import { describe, expect, it } from 'vitest';
import { SCOPES } from './auth.js';
import { CHAT_MESSAGES_CREATE_SCOPE } from '../chat/client.js';
import { SHEETS_SCOPE } from '../sheets/client.js';

describe('SCOPES', () => {
  it('asks for the Chat message-posting scope', () => {
    expect(SCOPES).toContain('https://www.googleapis.com/auth/chat.messages.create');
  });

  it('asks for exactly the scope post_chat_message names in its errors', () => {
    // The tool quotes CHAT_MESSAGES_CREATE_SCOPE back at the reader together
    // with `npm run auth -- <alias>`. If the two ever drift apart, that advice
    // becomes a lie.
    expect(SCOPES).toContain(CHAT_MESSAGES_CREATE_SCOPE);
  });

  it('keeps the two read-only Chat scopes — create does not include read', () => {
    // chat.messages.create grants posting and nothing else: listing and
    // reading messages still need chat.messages.readonly, and spaces.get (the
    // display name in a post's answer) still needs chat.spaces.readonly.
    expect(SCOPES).toContain('https://www.googleapis.com/auth/chat.messages.readonly');
    expect(SCOPES).toContain('https://www.googleapis.com/auth/chat.spaces.readonly');
  });

  it('already asks for what the Sheets writes need — no re-consent round', () => {
    // Steve's ruling, 2026-09-01: the Sheets tools ride the drive.file grant
    // every alias already holds rather than adding a `spreadsheets` scope that
    // would put five accounts through consent again. This is what makes the
    // CHANGELOG's "no fresh sign-in needed" a fact rather than a hope — and if
    // anyone ever widens SHEETS_SCOPE without adding it here, this fails.
    expect(SHEETS_SCOPE).toBe('https://www.googleapis.com/auth/drive.file');
    expect(SCOPES).toContain(SHEETS_SCOPE);
  });

  it('does not ask for the wide spreadsheets scope, which nothing here needs', () => {
    expect(SCOPES).not.toContain('https://www.googleapis.com/auth/spreadsheets');
  });

  it('lists no scope twice', () => {
    expect(new Set(SCOPES).size).toBe(SCOPES.length);
  });
});
