/**
 * PB — the Workspace-admin client: who may call it, what it says when Google
 * refuses, and the one table that translates group settings both ways.
 *
 * Nothing here touches the network, a token file or a real Workspace.
 * `googleapis`, the OAuth client and the account config are stubbed; the module
 * under test is the real one.
 *
 * The refusal half is the part worth reading twice. Every other client in this
 * server happily falls back to the default account, and the default account
 * here is a consumer Gmail mailbox. An admin call that quietly landed there
 * would be a directory call made against the wrong company — so `account` is
 * required, the flag is checked BEFORE any client is built, and both of those
 * are pinned below.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const directoryApi = { domains: { list: vi.fn() } };
const groupsSettingsApi = { groups: { get: vi.fn(), patch: vi.fn() } };

const adminFactory = vi.fn((_options: unknown) => directoryApi);
const groupsSettingsFactory = vi.fn((_options: unknown) => groupsSettingsApi);

vi.mock('googleapis', () => ({
  google: {
    admin: (options: unknown) => adminFactory(options),
    groupssettings: (options: unknown) => groupsSettingsFactory(options),
  },
}));

const getAuthClient = vi.fn(async (_account: unknown) => ({ authed: true }));
vi.mock('../gmail/auth.js', () => ({ getAuthClient: (account: unknown) => getAuthClient(account) }));

interface TestAccount { alias: string; email: string; workspace_admin?: boolean }

const ACCOUNTS: TestAccount[] = [
  { alias: 'personal', email: 'me@gmail.com' },
  { alias: 'info-ah', email: 'info@appraisalhost.com' },
  { alias: 'steve-ah', email: 'steve@appraisalhost.com', workspace_admin: true },
  { alias: 'steve-optiwork', email: 'steve@optiwork.ai', workspace_admin: true },
];

let accounts: TestAccount[] = ACCOUNTS;

vi.mock('../config.js', () => ({
  getAccounts: () => accounts,
  resolveAccount: (input?: string) => {
    const needle = (input ?? '').trim().toLowerCase();
    const found = accounts.find(
      a => a.alias.toLowerCase() === needle || a.email.toLowerCase() === needle,
    );
    if (!found) throw new Error(`Unknown account: "${input}".`);
    return found;
  },
}));

const {
  ADMIN_DIRECTORY_DOMAIN_SCOPE,
  ADMIN_DIRECTORY_GROUP_MEMBER_SCOPE,
  ADMIN_DIRECTORY_GROUP_SCOPE,
  ADMIN_DIRECTORY_USER_SCOPE,
  ADMIN_SDK_API,
  GROUPS_SETTINGS_API,
  GROUPS_SETTINGS_SCOPE,
  GROUP_SETTING_FIELDS,
  MY_CUSTOMER,
  adminApiError,
  customerOrDomain,
  fromGoogleSettings,
  getDirectoryClient,
  getGroupsSettingsClient,
  mayHaveLandedError,
  requireAdminAccount,
  toGoogleSettings,
} = await import('./client.js');

/** A Google API error in the shape googleapis actually throws. */
function googleError(status: number, reason: string, message: string): Error {
  return Object.assign(new Error(message), {
    code: status,
    errors: [{ reason }],
    response: { status, data: { error: { errors: [{ reason }] }, message } },
  });
}

const CTX = { tool: 'create_group', target: 'group', key: 'sales@optiwork.ai', alias: 'steve-optiwork' };

beforeEach(() => {
  accounts = ACCOUNTS;
  adminFactory.mockClear();
  groupsSettingsFactory.mockClear();
  getAuthClient.mockClear();
});

// ---------------------------------------------------------------------------
// requireAdminAccount — the refusal that happens before the network
// ---------------------------------------------------------------------------

describe('requireAdminAccount', () => {
  it('returns a flagged account', () => {
    expect(requireAdminAccount('steve-optiwork').alias).toBe('steve-optiwork');
    expect(requireAdminAccount('steve@appraisalhost.com').alias).toBe('steve-ah');
  });

  it('REFUSES an account that is not flagged', () => {
    expect(() => requireAdminAccount('personal')).toThrow(/not marked as a Google Workspace administrator/i);
  });

  it('names the alias it was given, the field to set, and which aliases ARE flagged', () => {
    let message = '';
    try {
      requireAdminAccount('info-ah');
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('info-ah');
    expect(message).toContain('"workspace_admin": true');
    expect(message).toContain('accounts.json');
    // The whole point of listing them: the reader can retry immediately.
    expect(message).toContain('steve-ah');
    expect(message).toContain('steve-optiwork');
  });

  it('says "none are flagged" rather than trailing off into an empty list', () => {
    accounts = [{ alias: 'personal', email: 'me@gmail.com' }];
    expect(() => requireAdminAccount('personal')).toThrow(/none are flagged/i);
  });

  it('REFUSES a missing account rather than falling back to the default one', () => {
    // Every other client in this server defaults. This one must not: the
    // default account is a consumer mailbox, and an admin call landing there is
    // the mistake this design exists to make impossible.
    expect(() => requireAdminAccount()).toThrow(/account is required/i);
    expect(() => requireAdminAccount('   ')).toThrow(/account is required/i);
  });

  it('passes an unknown alias straight through as unknown', () => {
    expect(() => requireAdminAccount('nope')).toThrow(/Unknown account/);
  });

  it('builds no client and asks for no token when it refuses', () => {
    expect(() => requireAdminAccount('personal')).toThrow();
    expect(getAuthClient).not.toHaveBeenCalled();
    expect(adminFactory).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The two clients and their cache
// ---------------------------------------------------------------------------

describe('the API clients', () => {
  it('builds a Directory client on the account it was handed', async () => {
    const account = requireAdminAccount('steve-optiwork');
    await getDirectoryClient(account);
    expect(getAuthClient).toHaveBeenCalledWith(account);
    expect(adminFactory).toHaveBeenCalledWith(
      expect.objectContaining({ version: 'directory_v1' }),
    );
  });

  it('builds a Groups Settings client too', async () => {
    await getGroupsSettingsClient(requireAdminAccount('steve-optiwork'));
    expect(groupsSettingsFactory).toHaveBeenCalledWith(expect.objectContaining({ version: 'v1' }));
  });

  it('caches per account, so a second call in the same window builds nothing new', async () => {
    const account = requireAdminAccount('steve-ah');
    const first = await getDirectoryClient(account);
    adminFactory.mockClear();
    const second = await getDirectoryClient(account);
    expect(second).toBe(first);
    expect(adminFactory).not.toHaveBeenCalled();
  });

  it('does not hand one account the other account\'s client', async () => {
    // Two aliases, two Workspaces, one process. Sharing a cache entry between
    // them would run a directory call against the wrong company.
    adminFactory.mockClear();
    await getDirectoryClient(requireAdminAccount('steve-optiwork'));
    await getDirectoryClient(requireAdminAccount('steve-ah'));
    expect(adminFactory).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Which customer a list call is about
// ---------------------------------------------------------------------------

describe('customerOrDomain', () => {
  it('defaults to the whole Workspace this account administers', () => {
    expect(customerOrDomain()).toEqual({ customer: MY_CUSTOMER });
    expect(MY_CUSTOMER).toBe('my_customer');
  });

  it('narrows to one domain when a domain is given, and sends ONLY that', () => {
    // Google requires exactly one of the two. Sending both is refused at the
    // far end with a message about neither.
    expect(customerOrDomain('optiwork.ai')).toEqual({ domain: 'optiwork.ai' });
    expect(customerOrDomain('optiwork.ai')).not.toHaveProperty('customer');
  });

  it('treats blank as absent', () => {
    expect(customerOrDomain('   ')).toEqual({ customer: MY_CUSTOMER });
  });
});

// ---------------------------------------------------------------------------
// The settings table
// ---------------------------------------------------------------------------

describe('GROUP_SETTING_FIELDS', () => {
  it('carries every setting the design allow-listed, and nothing else', () => {
    expect(GROUP_SETTING_FIELDS.map(f => f.param)).toEqual([
      'who_can_post_message',
      'allow_external_members',
      'who_can_view_group',
      'who_can_view_membership',
      'who_can_join',
      'who_can_discover_group',
      'who_can_contact_owner',
      'message_moderation_level',
      'spam_moderation_level',
      'reply_to',
      'custom_reply_to',
      'include_in_global_address_list',
      'allow_web_posting',
      'is_archived',
      'enable_collaborative_inbox',
      'members_can_post_as_the_group',
      'who_can_leave_group',
      'name',
      'description',
    ]);
  });

  it('maps each one to the field name Google actually uses', () => {
    const byParam = Object.fromEntries(GROUP_SETTING_FIELDS.map(f => [f.param, f.api]));
    expect(byParam).toMatchObject({
      who_can_post_message: 'whoCanPostMessage',
      allow_external_members: 'allowExternalMembers',
      who_can_view_group: 'whoCanViewGroup',
      who_can_view_membership: 'whoCanViewMembership',
      who_can_join: 'whoCanJoin',
      who_can_discover_group: 'whoCanDiscoverGroup',
      who_can_contact_owner: 'whoCanContactOwner',
      message_moderation_level: 'messageModerationLevel',
      spam_moderation_level: 'spamModerationLevel',
      reply_to: 'replyTo',
      custom_reply_to: 'customReplyTo',
      include_in_global_address_list: 'includeInGlobalAddressList',
      allow_web_posting: 'allowWebPosting',
      is_archived: 'isArchived',
      enable_collaborative_inbox: 'enableCollaborativeInbox',
      members_can_post_as_the_group: 'membersCanPostAsTheGroup',
      who_can_leave_group: 'whoCanLeaveGroup',
      name: 'name',
      description: 'description',
    });
  });

  it('gives every enum its values and every boolean none', () => {
    for (const field of GROUP_SETTING_FIELDS) {
      if (field.kind === 'enum') {
        expect(field.values, `${field.param} has no values`).toBeTruthy();
        expect((field.values ?? []).length).toBeGreaterThan(1);
      } else {
        expect(field.values).toBeUndefined();
      }
    }
  });

  it('spells the four enums that decide whether outside mail gets through', () => {
    const values = (param: string) =>
      GROUP_SETTING_FIELDS.find(f => f.param === param)?.values;
    expect(values('who_can_post_message')).toEqual([
      'NONE_CAN_POST', 'ALL_MANAGERS_CAN_POST', 'ALL_MEMBERS_CAN_POST',
      'ALL_OWNERS_CAN_POST', 'ALL_IN_DOMAIN_CAN_POST', 'ANYONE_CAN_POST',
    ]);
    expect(values('spam_moderation_level')).toEqual(['ALLOW', 'MODERATE', 'SILENTLY_MODERATE', 'REJECT']);
    expect(values('message_moderation_level')).toEqual([
      'MODERATE_ALL_MESSAGES', 'MODERATE_NON_MEMBERS', 'MODERATE_NEW_MEMBERS', 'MODERATE_NONE',
    ]);
    expect(values('reply_to')).toEqual([
      'REPLY_TO_CUSTOM', 'REPLY_TO_SENDER', 'REPLY_TO_LIST',
      'REPLY_TO_OWNER', 'REPLY_TO_IGNORE', 'REPLY_TO_MANAGERS',
    ]);
  });

  it('names no field twice on either side', () => {
    expect(new Set(GROUP_SETTING_FIELDS.map(f => f.param)).size).toBe(GROUP_SETTING_FIELDS.length);
    expect(new Set(GROUP_SETTING_FIELDS.map(f => f.api)).size).toBe(GROUP_SETTING_FIELDS.length);
  });
});

describe('toGoogleSettings', () => {
  it('renames to camelCase and writes booleans as the STRINGS Google wants', () => {
    // This is not cosmetic: the Groups Settings API carries every boolean as
    // "true"/"false" text, and a real JSON boolean is rejected or ignored.
    expect(toGoogleSettings({ allow_external_members: true, is_archived: false })).toEqual({
      allowExternalMembers: 'true',
      isArchived: 'false',
    });
  });

  it('passes enums and text through untouched', () => {
    expect(toGoogleSettings({
      who_can_post_message: 'ANYONE_CAN_POST',
      custom_reply_to: 'help@optiwork.ai',
      name: 'Sales',
    })).toEqual({
      whoCanPostMessage: 'ANYONE_CAN_POST',
      customReplyTo: 'help@optiwork.ai',
      name: 'Sales',
    });
  });

  it('sends only the keys it was given — a patch never restates a setting nobody touched', () => {
    expect(Object.keys(toGoogleSettings({ is_archived: true }))).toEqual(['isArchived']);
  });

  it('builds the whole "accepts outside mail" posture in one object', () => {
    expect(toGoogleSettings({
      who_can_post_message: 'ANYONE_CAN_POST',
      allow_external_members: true,
      spam_moderation_level: 'ALLOW',
      message_moderation_level: 'MODERATE_NONE',
    })).toEqual({
      whoCanPostMessage: 'ANYONE_CAN_POST',
      allowExternalMembers: 'true',
      spamModerationLevel: 'ALLOW',
      messageModerationLevel: 'MODERATE_NONE',
    });
  });

  it('refuses a key that is not on the allow-list, naming it', () => {
    expect(() => toGoogleSettings({ whoCanPostMessage: 'ANYONE_CAN_POST' }))
      .toThrow(/whoCanPostMessage/);
  });

  it('refuses a value outside an enum rather than letting Google reject it later', () => {
    expect(() => toGoogleSettings({ who_can_post_message: 'EVERYONE' })).toThrow(/EVERYONE/);
  });

  it('refuses a boolean field given a string, and an enum given a boolean', () => {
    expect(() => toGoogleSettings({ allow_external_members: 'true' })).toThrow(/allow_external_members/);
    expect(() => toGoogleSettings({ who_can_post_message: true })).toThrow(/who_can_post_message/);
  });
});

describe('fromGoogleSettings', () => {
  it('renames back and turns the string booleans into real ones', () => {
    expect(fromGoogleSettings({
      whoCanPostMessage: 'ANYONE_CAN_POST',
      allowExternalMembers: 'true',
      isArchived: 'false',
    })).toMatchObject({
      who_can_post_message: 'ANYONE_CAN_POST',
      allow_external_members: true,
      is_archived: false,
    });
  });

  it('is the exact inverse of toGoogleSettings across every field', () => {
    const original: Record<string, string | boolean> = {};
    for (const field of GROUP_SETTING_FIELDS) {
      original[field.param] = field.kind === 'boolean'
        ? true
        : field.kind === 'enum'
          ? (field.values ?? [''])[0]
          : 'some text';
    }
    expect(fromGoogleSettings(toGoogleSettings(original))).toEqual(original);
  });

  it('keeps the address, which is read-only and not a setting anyone sets', () => {
    expect(fromGoogleSettings({ email: 'sales@optiwork.ai' })).toMatchObject({
      email: 'sales@optiwork.ai',
    });
  });

  it('drops everything Google sends that the allow-list does not name', () => {
    const projected = fromGoogleSettings({
      whoCanAddReferences: 'NONE',
      maxMessageBytes: 26214400,
      allowExternalMembers: 'true',
    });
    expect(projected).not.toHaveProperty('whoCanAddReferences');
    expect(projected).not.toHaveProperty('max_message_bytes');
    expect(projected).toHaveProperty('allow_external_members', true);
  });

  it('omits a field Google did not send rather than inventing a default for it', () => {
    // A settings read that filled the gaps would report a posture the group
    // does not have, and someone would act on it.
    expect(fromGoogleSettings({ allowExternalMembers: 'true' }))
      .not.toHaveProperty('who_can_post_message');
    expect(fromGoogleSettings({ isArchived: null })).not.toHaveProperty('is_archived');
  });

  it('leaves a boolean Google spelled some other way alone rather than guessing', () => {
    // Not "false because it is not the word true": an unreadable value is
    // reported as what arrived, so a Google change is visible instead of silent.
    expect(fromGoogleSettings({ allowExternalMembers: 'maybe' }))
      .toMatchObject({ allow_external_members: 'maybe' });
  });
});

// ---------------------------------------------------------------------------
// Honest failures
// ---------------------------------------------------------------------------

describe('adminApiError', () => {
  it('says "already exists" for a 409 on a create, and names the address', () => {
    const err = adminApiError(googleError(409, 'duplicate', 'Entity already exists.'), CTX);
    expect(err?.message).toMatch(/already exists/i);
    expect(err?.message).toContain('sales@optiwork.ai');
  });

  it('recognises Google\'s wording even when the reason code is missing', () => {
    const bare = Object.assign(new Error('Entity already exists.'), { code: 409 });
    expect(adminApiError(bare, CTX)?.message).toMatch(/already exists/i);
  });

  it('says a 404 means no such thing IN THIS WORKSPACE, not that the id is malformed', () => {
    const err = adminApiError(googleError(404, 'notFound', 'Resource Not Found: groupKey'), {
      ...CTX,
      tool: 'get_group',
    });
    expect(err?.message).toMatch(/no such group/i);
    expect(err?.message).toMatch(/administers/i);
    expect(err?.message).toContain('sales@optiwork.ai');
  });

  it('says a plain 403 is probably a missing ADMIN ROLE, and never says re-authenticate', () => {
    const err = adminApiError(googleError(403, 'forbidden', 'Not Authorized to access this resource/api'), CTX);
    expect(err?.message).toMatch(/admin role|not allowed to/i);
    expect(err?.message).toContain('steve-optiwork');
    // The standing rule: re-auth advice on a 403 that is not a missing scope
    // sends the reader round a loop that cannot fix anything.
    expect(err?.message).not.toMatch(/re-authenticat/i);
    expect(err?.message).not.toMatch(/npm run auth/);
  });

  it('leaves a MISSING SCOPE alone, so the shared translator names the scope and the command', () => {
    const scopeErr = googleError(403, 'insufficientPermissions', 'Request had insufficient authentication scopes.');
    expect(adminApiError(scopeErr, CTX)).toBeUndefined();
  });

  it('leaves an API-not-enabled 403 alone, so the shared translator names the console page', () => {
    const disabled = googleError(
      403,
      'accessNotConfigured',
      'Admin SDK API has not been used in project 12345 before or it is disabled.',
    );
    expect(adminApiError(disabled, CTX)).toBeUndefined();
  });

  it('leaves a rate-limit 403 alone, so it is still retried', () => {
    const limited = googleError(403, 'rateLimitExceeded', 'Rate Limit Exceeded');
    expect(adminApiError(limited, CTX)).toBeUndefined();
  });

  it('leaves a 500 and a 401 alone', () => {
    expect(adminApiError(googleError(500, 'backendError', 'Internal Error'), CTX)).toBeUndefined();
    expect(adminApiError(googleError(401, 'authError', 'Invalid Credentials'), CTX)).toBeUndefined();
  });
});

describe('mayHaveLandedError', () => {
  const landCtx = {
    tool: 'create_group',
    what: 'the group sales@optiwork.ai',
    check: 'get_group',
  };

  it('warns that a 5xx may have landed anyway, and names what to check with', () => {
    const wrapped = mayHaveLandedError(new Error('Service Unavailable'), 500, landCtx);
    const message = wrapped instanceof Error ? wrapped.message : String(wrapped);
    expect(message).toMatch(/may (already )?have (landed|been created)/i);
    expect(message).toContain('get_group');
    expect(message).toContain('sales@optiwork.ai');
  });

  it('warns the same way when there is no status at all — a dropped connection', () => {
    const wrapped = mayHaveLandedError(new Error('socket hang up'), undefined, landCtx);
    expect(String(wrapped)).toMatch(/may/i);
  });

  it('leaves a 4xx exactly as it was — nothing was created, so there is nothing to check', () => {
    const original = new Error('Entity already exists.');
    expect(mayHaveLandedError(original, 409, landCtx)).toBe(original);
  });
});

// ---------------------------------------------------------------------------
// Scope constants — each call has to name the scope IT needs
// ---------------------------------------------------------------------------

describe('the scope constants', () => {
  it('are the exact strings the consent flow asks for', async () => {
    const { ADMIN_SCOPES } = await import('../gmail/auth.js');
    for (const scope of [
      ADMIN_DIRECTORY_USER_SCOPE,
      ADMIN_DIRECTORY_GROUP_SCOPE,
      ADMIN_DIRECTORY_GROUP_MEMBER_SCOPE,
      ADMIN_DIRECTORY_DOMAIN_SCOPE,
      GROUPS_SETTINGS_SCOPE,
    ]) {
      // If these ever drift, every missing-scope error tells the reader to run
      // a command that cannot grant what it names.
      expect(ADMIN_SCOPES).toContain(scope);
    }
  });

  it('name the two APIs the way Google\'s console does', () => {
    expect(ADMIN_SDK_API).toBe('Google Admin SDK');
    expect(GROUPS_SETTINGS_API).toBe('Google Groups Settings');
  });
});
