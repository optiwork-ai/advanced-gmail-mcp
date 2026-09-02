import { describe, expect, it } from 'vitest';
import { type AccountConfig, selectAccount } from './config.js';

const accounts: AccountConfig[] = [
  { alias: 'personal', email: 'stephen.angelo@gmail.com' },
  { alias: 'steve-ah', email: 'steve@appraisalhost.com' },
  { alias: 'info-ah', email: 'info@appraisalhost.com' },
];

describe('selectAccount', () => {
  it('returns the default account when no input is given', () => {
    expect(selectAccount(accounts, 'steve-ah')).toEqual(accounts[1]);
    expect(selectAccount(accounts, 'steve-ah', undefined)).toEqual(accounts[1]);
    expect(selectAccount(accounts, 'steve-ah', '   ')).toEqual(accounts[1]);
  });

  it('matches the default alias case-insensitively', () => {
    expect(selectAccount(accounts, 'STEVE-AH')).toEqual(accounts[1]);
  });

  it('throws a named config error when the default alias is not in the account list', () => {
    expect(() => selectAccount(accounts, 'missing')).toThrow(
      /Config error: the default account "missing" is not present in accounts\.json/,
    );
  });

  it('throws a named config error when there are no accounts at all', () => {
    expect(() => selectAccount([], 'steve-ah')).toThrow(/Config error/);
  });

  it('matches an exact alias', () => {
    expect(selectAccount(accounts, 'personal', 'steve-ah')).toEqual(accounts[1]);
  });

  it('matches an exact alias case-insensitively on both sides', () => {
    expect(selectAccount(accounts, 'personal', 'STEVE-AH')).toEqual(accounts[1]);
    expect(
      selectAccount([{ alias: 'Work', email: 'w@x.com' }], 'Work', 'work'),
    ).toEqual({ alias: 'Work', email: 'w@x.com' });
  });

  it('matches an exact email', () => {
    expect(selectAccount(accounts, 'personal', 'steve@appraisalhost.com')).toEqual(accounts[1]);
  });

  it('matches an exact email case-insensitively on both sides', () => {
    expect(selectAccount(accounts, 'personal', 'Steve@AppraisalHost.com')).toEqual(accounts[1]);
    expect(
      selectAccount([{ alias: 'w', email: 'Mixed@Case.com' }], 'w', 'mixed@case.com'),
    ).toEqual({ alias: 'w', email: 'Mixed@Case.com' });
  });

  it('tolerates surrounding whitespace on the input', () => {
    expect(selectAccount(accounts, 'personal', '  steve-ah  ')).toEqual(accounts[1]);
  });

  it('prefers an alias over an email when both could match', () => {
    const overlapping: AccountConfig[] = [
      { alias: 'a@x.com', email: 'first@x.com' },
      { alias: 'second', email: 'a@x.com' },
    ];
    expect(selectAccount(overlapping, 'second', 'a@x.com')).toEqual(overlapping[0]);
  });

  it('REJECTS a substring of an email instead of guessing', () => {
    expect(() => selectAccount(accounts, 'personal', 'steve')).toThrow(
      /Unknown account: "steve"/,
    );
    expect(() => selectAccount(accounts, 'personal', 'appraisalhost.com')).toThrow(
      /Unknown account/,
    );
    expect(() => selectAccount(accounts, 'personal', '@')).toThrow(/Unknown account/);
  });

  it('lists the available aliases when nothing matches', () => {
    expect(() => selectAccount(accounts, 'personal', 'nope')).toThrow(
      /Valid aliases: personal, steve-ah, info-ah\./,
    );
  });
});

/**
 * PA — `workspace_admin` is the flag that decides which accounts get Google
 * Admin SDK power, and it lives in accounts.json beside the alias.
 *
 * Account selection is the only place it can be lost: everything downstream
 * receives an AccountConfig and reads the flag off it. A resolution that
 * dropped the field would leave a genuinely-flagged admin account refused by
 * every admin tool, with a message telling its owner to add a flag that is
 * already there.
 */
describe('selectAccount and the workspace_admin flag', () => {
  const mixed: AccountConfig[] = [
    { alias: 'personal', email: 'me@gmail.com' },
    { alias: 'steve-optiwork', email: 'steve@optiwork.ai', workspace_admin: true },
  ];

  it('carries the flag through an alias match', () => {
    expect(selectAccount(mixed, 'personal', 'steve-optiwork').workspace_admin).toBe(true);
  });

  it('carries the flag through an email match', () => {
    expect(selectAccount(mixed, 'personal', 'steve@optiwork.ai').workspace_admin).toBe(true);
  });

  it('carries the flag through the default-account path', () => {
    expect(selectAccount(mixed, 'steve-optiwork').workspace_admin).toBe(true);
  });

  it('leaves an unflagged account with no flag at all — absent means false', () => {
    expect(selectAccount(mixed, 'personal').workspace_admin).toBeUndefined();
  });
});
