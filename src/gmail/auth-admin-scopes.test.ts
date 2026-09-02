/**
 * PA — the consent request is now PER ACCOUNT, and this is what pins that.
 *
 * Until 2026-09-02 every alias was sent through the same `SCOPES` list. The
 * Workspace-admin work breaks that symmetry: only an account carrying
 * `"workspace_admin": true` in accounts.json asks Google for the Admin SDK
 * grants, because an admin scope on a consumer Gmail account is a permission
 * nobody needs and a consent screen nobody should be reading.
 *
 * Two things therefore have to be true at once, and both are checked here
 * against the REAL `authenticateAccount` rather than against the helper it
 * calls:
 *
 *   - a flagged account's consent URL asks for the base list AND the admin
 *     list, in that order;
 *   - an unflagged account's consent URL is byte-identical to the one this
 *     server built yesterday — the same array, same order, nothing added.
 *
 * The second is the one that protects the two accounts that are NOT admins:
 * a silent widening there would put admin power on a mailbox that never asked
 * for it, and no error would ever be raised.
 *
 * How the URL is captured without a browser, a port or a credential file:
 * `generateAuthUrl` is stubbed to record what it was handed and then throw, so
 * `authenticateAccount` rejects before it opens its callback server. Nothing
 * here reads or writes credentials.json — the `fs` this module sees is a stub
 * holding a dummy client id in memory.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Every `generateAuthUrl` call this test file has seen. */
const authUrlCalls: Array<{ scope?: string[]; login_hint?: string; prompt?: string }> = [];

/** Thrown by the stubbed generateAuthUrl so no callback server is ever opened. */
const STOP = 'stopped before the browser step';

vi.mock('googleapis', () => {
  class OAuth2 {
    generateAuthUrl(opts: { scope?: string[]; login_hint?: string; prompt?: string }): string {
      authUrlCalls.push(opts);
      throw new Error(STOP);
    }
  }
  return { google: { auth: { OAuth2 } } };
});

/**
 * A stub `fs` carrying a dummy OAuth client in memory. No credential file is
 * created, copied or read — the point is only that `loadCredentials` gets past
 * its existence check with something shaped like a client.
 */
vi.mock('fs', () => {
  const api = {
    existsSync: () => true,
    readFileSync: () => JSON.stringify({
      installed: { client_id: 'test-client-id', client_secret: 'test-client-secret' },
    }),
    writeFileSync: () => undefined,
    mkdirSync: () => undefined,
  };
  return { ...api, default: api };
});

vi.mock('../config.js', () => ({
  getAccounts: () => [],
  getCredentialsPath: () => '/nonexistent/credentials.json',
  getTokenPath: (account: { alias: string }) => `/nonexistent/tokens/${account.alias}.json`,
  resolveAccount: (input?: string) => ({ alias: input ?? 'test', email: 'me@example.com' }),
}));

const { ADMIN_SCOPES, SCOPES, authenticateAccount, scopesFor } = await import('./auth.js');

/** Run the consent flow far enough to capture the scope list it asked for. */
async function requestedScopes(account: { alias: string; email: string; workspace_admin?: boolean }): Promise<string[]> {
  await expect(authenticateAccount(account)).rejects.toThrow(STOP);
  const last = authUrlCalls.at(-1);
  if (!last) throw new Error('generateAuthUrl was never called');
  return last.scope ?? [];
}

const ADMIN = { alias: 'steve-optiwork', email: 'steve@optiwork.ai', workspace_admin: true };
const PLAIN = { alias: 'personal', email: 'me@gmail.com' };

beforeEach(() => {
  authUrlCalls.length = 0;
});

describe('the consent request an account actually gets', () => {
  it('asks a flagged account for the base scopes AND the admin scopes, in that order', async () => {
    expect(await requestedScopes(ADMIN)).toEqual([...SCOPES, ...ADMIN_SCOPES]);
  });

  it('asks an UNFLAGGED account for exactly what it asked for yesterday — nothing added', async () => {
    // The whole safety case for per-account scopes rests here. `personal` is a
    // consumer Gmail account: it has no Workspace to administer, and a widening
    // that reached it would grant directory power to a mailbox nobody chose.
    expect(await requestedScopes(PLAIN)).toEqual(SCOPES);
  });

  it('treats workspace_admin: false the same as absent', async () => {
    expect(await requestedScopes({ ...PLAIN, workspace_admin: false })).toEqual(SCOPES);
  });

  it('still logs in as the named account and still forces the consent screen', async () => {
    await requestedScopes(ADMIN);
    const last = authUrlCalls.at(-1);
    expect(last?.login_hint).toBe(ADMIN.email);
    // Without prompt: 'consent' Google may return a token that silently keeps
    // the OLD grant set, which is precisely the failure a re-consent round is
    // run to fix.
    expect(last?.prompt).toBe('consent');
  });
});

describe('scopesFor', () => {
  it('is the base list for an account with no flag', () => {
    expect(scopesFor(PLAIN)).toEqual(SCOPES);
  });

  it('appends the admin list for a flagged account and changes the base list not at all', () => {
    const before = [...SCOPES];
    expect(scopesFor(ADMIN)).toEqual([...SCOPES, ...ADMIN_SCOPES]);
    expect(SCOPES).toEqual(before);
  });

  it('hands back a fresh array each time, so a caller cannot mutate SCOPES through it', () => {
    const list = scopesFor(PLAIN);
    list.push('https://example.invalid/not-a-scope');
    expect(SCOPES).not.toContain('https://example.invalid/not-a-scope');
  });
});

describe('ADMIN_SCOPES', () => {
  it('is exactly the eleven scopes the admin tools call, in the order the design fixed', () => {
    // Verified against Google's Directory API "authorizing" page on 2026-09-02.
    // This is a deliberate pin, not a restatement: a scope quietly added here
    // puts every flagged account through a consent screen asking for more than
    // the tools use, and a scope quietly removed makes a tool 403 forever while
    // its error tells the reader to run a command that cannot help.
    expect(ADMIN_SCOPES).toEqual([
      'https://www.googleapis.com/auth/admin.directory.user',
      'https://www.googleapis.com/auth/admin.directory.user.security',
      'https://www.googleapis.com/auth/admin.directory.group',
      'https://www.googleapis.com/auth/admin.directory.group.member',
      'https://www.googleapis.com/auth/admin.directory.orgunit',
      'https://www.googleapis.com/auth/admin.directory.domain',
      'https://www.googleapis.com/auth/admin.directory.customer',
      'https://www.googleapis.com/auth/admin.directory.rolemanagement',
      'https://www.googleapis.com/auth/admin.directory.resource.calendar',
      'https://www.googleapis.com/auth/admin.directory.userschema',
      'https://www.googleapis.com/auth/apps.groups.settings',
    ]);
  });

  it('asks for no device-management scope', () => {
    // Deliberately excluded: this lane is mail configuration, and wiping or
    // locking a phone is not part of it. One re-consent adds them if that ever
    // becomes the job.
    expect(ADMIN_SCOPES.filter(s => s.includes('device'))).toEqual([]);
  });

  it('asks for no separate alias scope, because there is none to ask for', () => {
    // Google folds user aliases into admin.directory.user and group aliases
    // into admin.directory.group. An `admin.directory.user.alias` on the
    // consent screen would be asking for something that does not exist.
    expect(ADMIN_SCOPES.filter(s => s.includes('.alias'))).toEqual([]);
  });

  it('lists no scope twice, and shares none with the base list', () => {
    expect(new Set(ADMIN_SCOPES).size).toBe(ADMIN_SCOPES.length);
    expect(ADMIN_SCOPES.filter(s => SCOPES.includes(s))).toEqual([]);
  });

  it('keeps SCOPES free of every admin grant — the base list is what a mailbox gets', () => {
    expect(SCOPES.filter(s => s.includes('admin.directory') || s.includes('apps.groups.settings')))
      .toEqual([]);
  });
});
