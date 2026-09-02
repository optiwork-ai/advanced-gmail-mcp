/**
 * PA — what `npm run auth:check` says about admin power.
 *
 * The admin scopes are useless until each flagged alias signs in AGAIN: adding
 * a scope to the list does nothing to a token already on disk. That gap is
 * invisible from the outside — the tools simply 403 — so the status board has
 * to show it. Three states, and this file pins all three:
 *
 *   - the token really carries directory power   → ` [admin]`
 *   - flagged in accounts.json but the token does not → ` [admin: NOT CONSENTED …]`
 *     with the exact command that fixes it
 *   - not flagged at all → nothing, so the two mailbox-only accounts read
 *     exactly as they did yesterday
 *
 * Real files, real token JSON, a real temp directory — only `config.js` is
 * stubbed, so the function under test is the one `src/auth.ts --check` calls.
 * No credential file is created: `checkAuthStatus` reads tokens and nothing
 * else.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const TOKEN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-mcp-auth-status-'));

interface TestAccount {
  alias: string;
  email: string;
  workspace_admin?: boolean;
}

/** Rewritten per test, then read by the stubbed getAccounts below. */
let accounts: TestAccount[] = [];

vi.mock('../config.js', () => ({
  getAccounts: () => accounts,
  getTokenPath: (account: { alias: string }) => path.join(TOKEN_DIR, `${account.alias}.json`),
  getCredentialsPath: () => path.join(TOKEN_DIR, 'credentials-not-used.json'),
  resolveAccount: (input?: string) => accounts.find(a => a.alias === input) ?? accounts[0],
}));

const { checkAuthStatus } = await import('./auth.js');

/** The Gmail-and-friends grants every alias has held since 2026-08-28. */
const BASE_SCOPE = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.compose',
].join(' ');

const ADMIN_SCOPE = [
  BASE_SCOPE,
  'https://www.googleapis.com/auth/admin.directory.user',
  'https://www.googleapis.com/auth/admin.directory.group',
].join(' ');

function writeToken(alias: string, scope: string): void {
  fs.writeFileSync(
    path.join(TOKEN_DIR, `${alias}.json`),
    JSON.stringify({ access_token: 'not-a-real-token', scope, expiry_date: Date.now() + 3_600_000 }),
  );
}

/** Run the status board and hand back everything it printed, as one string. */
function statusOutput(): string {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  try {
    checkAuthStatus();
  } finally {
    spy.mockRestore();
  }
  return lines.join('\n');
}

/** The one printed line naming this alias. */
function lineFor(output: string, alias: string): string {
  const line = output.split('\n').find(l => l.includes(` ${alias} `) || l.includes(`${alias} `));
  if (!line) throw new Error(`no status line for ${alias} in:\n${output}`);
  return line;
}

beforeEach(() => {
  accounts = [];
  for (const file of fs.readdirSync(TOKEN_DIR)) fs.rmSync(path.join(TOKEN_DIR, file));
});

afterAll(() => {
  fs.rmSync(TOKEN_DIR, { recursive: true, force: true });
});

describe('checkAuthStatus and the admin marker', () => {
  it('says [admin] when the stored token really carries directory power', () => {
    accounts = [{ alias: 'steve-optiwork', email: 'steve@optiwork.ai', workspace_admin: true }];
    writeToken('steve-optiwork', ADMIN_SCOPE);

    const line = lineFor(statusOutput(), 'steve-optiwork');
    expect(line).toContain('[send+compose]');
    expect(line).toContain('[admin]');
    expect(line).not.toContain('NOT CONSENTED');
  });

  it('says NOT CONSENTED, and the exact command, for a flagged account whose token predates the scopes', () => {
    accounts = [{ alias: 'steve-ah', email: 'steve@appraisalhost.com', workspace_admin: true }];
    writeToken('steve-ah', BASE_SCOPE);

    const line = lineFor(statusOutput(), 'steve-ah');
    expect(line).toContain('[admin: NOT CONSENTED');
    // The command has to be the one that works, alias and all — a status board
    // that says "re-authenticate" without saying how is the thing this replaces.
    expect(line).toContain('npm run auth -- steve-ah');
  });

  it('says nothing at all about admin for an account that is not flagged', () => {
    accounts = [{ alias: 'personal', email: 'me@gmail.com' }];
    writeToken('personal', BASE_SCOPE);

    const line = lineFor(statusOutput(), 'personal');
    expect(line).toContain('[send+compose]');
    expect(line).not.toContain('admin');
  });

  it('still says [admin] if the flag was removed while the token still holds the grant', () => {
    // The honest reading: the flag decides what is REQUESTED next time, the
    // token decides what the account can do right now. Un-flagging an account
    // does not take its directory power away — only re-consenting or revoking
    // does — and a board that stopped mentioning it would be hiding live power.
    accounts = [{ alias: 'steve-hub', email: 'steve@theappraisalhub.com' }];
    writeToken('steve-hub', ADMIN_SCOPE);

    expect(lineFor(statusOutput(), 'steve-hub')).toContain('[admin]');
  });

  it('leaves an unauthenticated flagged account reading as unauthenticated', () => {
    accounts = [{ alias: 'steve-hub', email: 'steve@theappraisalhub.com', workspace_admin: true }];

    const line = lineFor(statusOutput(), 'steve-hub');
    expect(line).toContain('NOT AUTHENTICATED');
    // No admin clause: there is no token to have or lack a scope, and telling
    // someone to grant an extra scope before they have signed in at all is
    // noise on top of the real instruction.
    expect(line).not.toContain('[admin');
  });

  it('reports a corrupt token as corrupt rather than guessing at its scopes', () => {
    accounts = [{ alias: 'steve-ah', email: 'steve@appraisalhost.com', workspace_admin: true }];
    fs.writeFileSync(path.join(TOKEN_DIR, 'steve-ah.json'), 'not json at all');

    const line = lineFor(statusOutput(), 'steve-ah');
    expect(line).toContain('TOKEN CORRUPT');
    expect(line).not.toContain('[admin');
  });

  it('marks each account on its own — one admin among mailboxes does not colour the rest', () => {
    accounts = [
      { alias: 'personal', email: 'me@gmail.com' },
      { alias: 'steve-optiwork', email: 'steve@optiwork.ai', workspace_admin: true },
      { alias: 'info-ah', email: 'info@appraisalhost.com' },
    ];
    writeToken('personal', BASE_SCOPE);
    writeToken('steve-optiwork', ADMIN_SCOPE);
    writeToken('info-ah', BASE_SCOPE);

    const output = statusOutput();
    expect(lineFor(output, 'personal')).not.toContain('admin');
    expect(lineFor(output, 'steve-optiwork')).toContain('[admin]');
    expect(lineFor(output, 'info-ah')).not.toContain('admin');
  });
});
