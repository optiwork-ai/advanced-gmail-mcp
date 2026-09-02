/**
 * PB — the fourteen Google Workspace admin tools, exercised through the
 * handlers the MCP server actually registers.
 *
 * `googleapis`, the OAuth client, the account config and the logger are
 * stubbed; `src/workspace-admin/client.ts` and every tool module are the REAL
 * ones. What is pinned here is the request that would go to Google and the
 * words that come back — not a mock of our own design. Nothing touches the
 * network, a token file or a real Workspace.
 *
 * Three themes run through it, and they are the three ways this set of tools
 * could hurt somebody:
 *
 *  - **the wrong account.** Every tool requires `account` and refuses one that
 *    is not flagged, before any network call. A directory write landing on the
 *    wrong company is the failure this whole design is shaped around.
 *  - **a write that half-happened.** create_group does three things and any of
 *    them can fail; the result has to say exactly which landed. Creates and
 *    deletes are never retried, because a retry after a timeout makes a second
 *    group — or a second paid user seat.
 *  - **a secret in a log.** create_workspace_user can mint a password. It is
 *    returned once and never written to the log.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// --- the two Google clients, stubbed ---------------------------------------

const directoryApi = {
  domains: { list: vi.fn() },
  users: {
    list: vi.fn(),
    get: vi.fn(),
    insert: vi.fn(),
    patch: vi.fn(),
    aliases: { insert: vi.fn() },
  },
  groups: {
    list: vi.fn(),
    get: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
    aliases: { insert: vi.fn() },
  },
  members: { list: vi.fn(), insert: vi.fn(), delete: vi.fn() },
};

const settingsApi = { groups: { get: vi.fn(), patch: vi.fn() } };

vi.mock('googleapis', () => ({
  google: {
    admin: () => directoryApi,
    groupssettings: () => settingsApi,
  },
}));

vi.mock('../gmail/auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../gmail/auth.js')>();
  return { ...actual, getAuthClient: async () => ({ authed: true }) };
});

interface TestAccount { alias: string; email: string; workspace_admin?: boolean }

const ADMIN_ACCOUNT: TestAccount = {
  alias: 'steve-optiwork',
  email: 'steve@optiwork.ai',
  workspace_admin: true,
};
const PLAIN_ACCOUNT: TestAccount = { alias: 'personal', email: 'me@gmail.com' };

vi.mock('../config.js', () => ({
  getAccounts: () => [ADMIN_ACCOUNT, PLAIN_ACCOUNT],
  resolveAccount: (input?: string) => {
    const needle = (input ?? '').trim().toLowerCase();
    const found = [ADMIN_ACCOUNT, PLAIN_ACCOUNT].find(
      a => a.alias.toLowerCase() === needle || a.email.toLowerCase() === needle,
    );
    if (!found) throw new Error(`Unknown account: "${input}".`);
    return found;
  },
}));

const logCalls: { level: string; message: string; fields: Record<string, unknown> }[] = [];
vi.mock('../log.js', () => ({
  log: (level: string, message: string, fields: Record<string, unknown> = {}) => {
    logCalls.push({ level, message, fields });
  },
}));

// --- the tools themselves --------------------------------------------------

const { registerListWorkspaceDomains, listWorkspaceDomainsParams } =
  await import('./workspace-list-domains.js');
const { registerListWorkspaceUsers, listWorkspaceUsersParams } =
  await import('./workspace-list-users.js');
const { registerGetWorkspaceUser, getWorkspaceUserParams } =
  await import('./workspace-get-user.js');
const { registerCreateWorkspaceUser, createWorkspaceUserParams, generateInitialPassword } =
  await import('./workspace-create-user.js');
const { registerUpdateWorkspaceUser, updateWorkspaceUserParams } =
  await import('./workspace-update-user.js');
const { registerAddUserAlias, addUserAliasParams } = await import('./workspace-add-user-alias.js');
const { registerListGroups, listGroupsParams } = await import('./workspace-list-groups.js');
const { registerGetGroup, getGroupParams } = await import('./workspace-get-group.js');
const { registerCreateGroup, createGroup, createGroupParams, GROUP_SETTINGS_RETRY_DELAYS_MS } =
  await import('./workspace-create-group.js');
const { registerUpdateGroupSettings, updateGroupSettingsParams } =
  await import('./workspace-update-group-settings.js');
const { registerDeleteGroup, deleteGroupParams } = await import('./workspace-delete-group.js');
const { registerAddGroupAlias, addGroupAliasParams } = await import('./workspace-add-group-alias.js');
const { registerGroupMemberTools, addGroupMemberParams, removeGroupMemberParams } =
  await import('./workspace-group-members.js');

// --- plumbing --------------------------------------------------------------

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

interface Captured { name: string; description: string; handler: Handler }

type Register = (server: never) => void;

function captureAll(register: Register): Captured[] {
  const captured: Captured[] = [];
  const server = {
    tool: (name: string, description: string, _params: unknown, handler: Handler) => {
      captured.push({ name, description, handler });
    },
  };
  register(server as never);
  if (captured.length === 0) throw new Error('the module registered nothing');
  return captured;
}

function capture(register: Register): Captured {
  return captureAll(register)[0];
}

function byName(register: Register, name: string): Captured {
  const found = captureAll(register).find(c => c.name === name);
  if (!found) throw new Error(`${name} was not registered`);
  return found;
}

/** Run a handler and parse the JSON it returned, failing loudly if it errored. */
async function ok(handler: Handler, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await handler(args);
  if (result.isError) throw new Error(`expected success, got: ${result.content[0].text}`);
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

/** Run a handler expecting a refusal, and hand back the message. */
async function fails(handler: Handler, args: Record<string, unknown>): Promise<string> {
  const result = await handler(args);
  expect(result.isError).toBe(true);
  return result.content[0].text;
}

function googleError(status: number, reason: string, message: string): Error {
  return Object.assign(new Error(message), {
    code: status,
    errors: [{ reason }],
    response: { status, data: { error: { errors: [{ reason }] }, message } },
  });
}

const ADMIN = 'steve-optiwork';

const RAW_GROUP = {
  id: '01abc',
  email: 'sales@optiwork.ai',
  name: 'Sales',
  description: 'the sales address',
  directMembersCount: '2',
  aliases: ['orders@optiwork.ai'],
  adminCreated: true,
  etag: 'noise',
  kind: 'admin#directory#group',
};

const RAW_SETTINGS = {
  email: 'sales@optiwork.ai',
  whoCanPostMessage: 'ANYONE_CAN_POST',
  allowExternalMembers: 'true',
  spamModerationLevel: 'ALLOW',
  messageModerationLevel: 'MODERATE_NONE',
  whoCanAddReferences: 'NONE',
  maxMessageBytes: 26214400,
};

const RAW_USER = {
  primaryEmail: 'emma.clarke@optiwork.ai',
  name: { givenName: 'Emma', familyName: 'Clarke', fullName: 'Emma Clarke' },
  suspended: false,
  isAdmin: false,
  orgUnitPath: '/',
  aliases: ['emma@optiwork.ai'],
  lastLoginTime: '2026-09-01T10:00:00.000Z',
  recoveryEmail: 'emma@example.com',
  creationTime: '2026-08-01T10:00:00.000Z',
  agreedToTerms: true,
  isEnrolledIn2Sv: false,
  changePasswordAtNextLogin: false,
  password: 'SHOULD-NEVER-BE-ECHOED',
  hashFunction: 'SHA-1',
  etag: 'noise',
};

beforeEach(() => {
  vi.clearAllMocks();
  logCalls.length = 0;
});

// ---------------------------------------------------------------------------
// The rule that applies to all fourteen
// ---------------------------------------------------------------------------

const everyTool: Array<{ label: string; register: Register; name: string; args: Record<string, unknown> }> = [
  { label: 'list_workspace_domains', register: registerListWorkspaceDomains, name: 'list_workspace_domains', args: {} },
  { label: 'list_workspace_users', register: registerListWorkspaceUsers, name: 'list_workspace_users', args: {} },
  { label: 'get_workspace_user', register: registerGetWorkspaceUser, name: 'get_workspace_user', args: { user_key: 'a@b.com' } },
  { label: 'create_workspace_user', register: registerCreateWorkspaceUser, name: 'create_workspace_user', args: { primary_email: 'a@b.com', given_name: 'A', family_name: 'B', confirm: true } },
  { label: 'update_workspace_user', register: registerUpdateWorkspaceUser, name: 'update_workspace_user', args: { user_key: 'a@b.com', given_name: 'A' } },
  { label: 'add_user_alias', register: registerAddUserAlias, name: 'add_user_alias', args: { user_key: 'a@b.com', alias: 'c@b.com' } },
  { label: 'list_groups', register: registerListGroups, name: 'list_groups', args: {} },
  { label: 'get_group', register: registerGetGroup, name: 'get_group', args: { group_key: 'g@b.com' } },
  { label: 'create_group', register: registerCreateGroup, name: 'create_group', args: { email: 'g@b.com', name: 'G' } },
  { label: 'update_group_settings', register: registerUpdateGroupSettings, name: 'update_group_settings', args: { group_key: 'g@b.com', settings: { is_archived: true } } },
  { label: 'delete_group', register: registerDeleteGroup, name: 'delete_group', args: { group_key: 'g@b.com', confirm: true } },
  { label: 'add_group_alias', register: registerAddGroupAlias, name: 'add_group_alias', args: { group_key: 'g@b.com', alias: 'x@b.com' } },
  { label: 'add_group_member', register: registerGroupMemberTools, name: 'add_group_member', args: { group_key: 'g@b.com', email: 'a@b.com' } },
  { label: 'remove_group_member', register: registerGroupMemberTools, name: 'remove_group_member', args: { group_key: 'g@b.com', email: 'a@b.com' } },
];

describe.each(everyTool)('$label refuses an account that must not make admin calls', ({ register, name, args }) => {
  it('refuses a non-flagged account, and calls nothing at Google', async () => {
    const { handler } = byName(register, name);
    const text = await fails(handler, { ...args, account: 'personal' });

    expect(text).toMatch(/not marked as a Google Workspace administrator/i);
    expect(text).toContain('"workspace_admin": true');
    for (const resource of [directoryApi.domains.list, directoryApi.groups.insert, directoryApi.users.insert]) {
      expect(resource).not.toHaveBeenCalled();
    }
  });

  it('refuses a call with no account at all rather than using the default one', async () => {
    const { handler } = byName(register, name);
    expect(await fails(handler, args)).toMatch(/account is required/i);
  });

  it('says in its description that it acts on the Workspace that account administers', () => {
    expect(byName(register, name).description).toMatch(/workspace/i);
    expect(byName(register, name).description).toMatch(/administers/i);
  });
});

describe('the account parameter', () => {
  const paramSets: Array<[string, { account: { isOptional(): boolean } }]> = [
    ['list_workspace_domains', listWorkspaceDomainsParams],
    ['list_workspace_users', listWorkspaceUsersParams],
    ['get_workspace_user', getWorkspaceUserParams],
    ['create_workspace_user', createWorkspaceUserParams],
    ['update_workspace_user', updateWorkspaceUserParams],
    ['add_user_alias', addUserAliasParams],
    ['list_groups', listGroupsParams],
    ['get_group', getGroupParams],
    ['create_group', createGroupParams],
    ['update_group_settings', updateGroupSettingsParams],
    ['delete_group', deleteGroupParams],
    ['add_group_alias', addGroupAliasParams],
    ['add_group_member', addGroupMemberParams],
    ['remove_group_member', removeGroupMemberParams],
  ];

  it.each(paramSets)('is REQUIRED on %s, so the schema itself refuses an omission', (_label, params) => {
    // Not merely checked at runtime: the tool's own schema says account is
    // required, so a model calling it without one is told before anything runs.
    expect(params.account.isOptional()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The reads
// ---------------------------------------------------------------------------

describe('list_workspace_domains', () => {
  it('asks about the whole Workspace and reports every domain with its primary flag', async () => {
    directoryApi.domains.list.mockResolvedValue({
      data: {
        domains: [
          { domainName: 'optiwork.ai', isPrimary: true, verified: true, domainAliases: [{ domainAliasName: 'optiwork.com' }] },
          { domainName: 'theappraisalhub.com', isPrimary: false, verified: true, domainAliases: [] },
        ],
      },
    });

    const out = await ok(capture(registerListWorkspaceDomains).handler, { account: ADMIN });

    expect(directoryApi.domains.list).toHaveBeenCalledWith({ customer: 'my_customer' });
    expect(out.domains).toEqual([
      { domainName: 'optiwork.ai', isPrimary: true, verified: true, domainAliases: ['optiwork.com'] },
      { domainName: 'theappraisalhub.com', isPrimary: false, verified: true, domainAliases: [] },
    ]);
  });

  it('says in its description that it answers whether a domain is its own Workspace', () => {
    // This is the question the tool was added to settle first: is
    // theappraisalhub.com a Workspace of its own, or a secondary domain of
    // appraisalhost.com's? The answer changes which account does the work.
    const { description } = capture(registerListWorkspaceDomains);
    expect(description).toMatch(/secondary domain|its own workspace/i);
  });
});

describe('list_workspace_users', () => {
  beforeEach(() => {
    directoryApi.users.list.mockResolvedValue({ data: { users: [RAW_USER], nextPageToken: 'more' } });
  });

  it('returns the projection it promises and never a password or a hash', async () => {
    const out = await ok(capture(registerListWorkspaceUsers).handler, { account: ADMIN });
    const users = out.users as Array<Record<string, unknown>>;

    expect(users[0]).toEqual({
      primaryEmail: 'emma.clarke@optiwork.ai',
      fullName: 'Emma Clarke',
      suspended: false,
      isAdmin: false,
      orgUnitPath: '/',
      aliases: ['emma@optiwork.ai'],
      lastLoginTime: '2026-09-01T10:00:00.000Z',
    });
    expect(JSON.stringify(out)).not.toContain('SHOULD-NEVER-BE-ECHOED');
    expect(JSON.stringify(out)).not.toContain('hashFunction');
    expect(out.nextPageToken).toBe('more');
  });

  it('defaults to 100, and caps a greedy request at 500 instead of failing it', async () => {
    const { handler } = capture(registerListWorkspaceUsers);
    await ok(handler, { account: ADMIN });
    expect(directoryApi.users.list).toHaveBeenCalledWith(expect.objectContaining({ maxResults: 100 }));

    await ok(handler, { account: ADMIN, max_results: 5000 });
    expect(directoryApi.users.list).toHaveBeenLastCalledWith(expect.objectContaining({ maxResults: 500 }));
  });

  it('narrows to one domain when asked, and sends only that — never both keys', async () => {
    await ok(capture(registerListWorkspaceUsers).handler, { account: ADMIN, domain: 'optiwork.ai' });
    const sent = directoryApi.users.list.mock.calls[0][0] as Record<string, unknown>;
    expect(sent.domain).toBe('optiwork.ai');
    expect(sent).not.toHaveProperty('customer');
  });

  it('passes a search query and a page token straight through', async () => {
    await ok(capture(registerListWorkspaceUsers).handler, {
      account: ADMIN, query: 'email:emma*', page_token: 'p2',
    });
    expect(directoryApi.users.list).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'email:emma*', pageToken: 'p2' }),
    );
  });
});

describe('get_workspace_user', () => {
  it('adds the fields a single read is for, and still no password', async () => {
    directoryApi.users.get.mockResolvedValue({ data: RAW_USER });

    const out = await ok(capture(registerGetWorkspaceUser).handler, {
      account: ADMIN, user_key: 'emma.clarke@optiwork.ai',
    });

    expect(directoryApi.users.get).toHaveBeenCalledWith({ userKey: 'emma.clarke@optiwork.ai' });
    expect(out.user).toMatchObject({
      primaryEmail: 'emma.clarke@optiwork.ai',
      recoveryEmail: 'emma@example.com',
      creationTime: '2026-08-01T10:00:00.000Z',
      agreedToTerms: true,
      isEnrolledIn2Sv: false,
      changePasswordAtNextLogin: false,
    });
    expect(JSON.stringify(out)).not.toContain('SHOULD-NEVER-BE-ECHOED');
  });
});

describe('list_groups', () => {
  beforeEach(() => {
    directoryApi.groups.list.mockResolvedValue({ data: { groups: [RAW_GROUP], nextPageToken: null } });
  });

  it('projects the group fields and drops Google\'s bookkeeping', async () => {
    const out = await ok(capture(registerListGroups).handler, { account: ADMIN });
    expect((out.groups as Array<Record<string, unknown>>)[0]).toEqual({
      email: 'sales@optiwork.ai',
      name: 'Sales',
      description: 'the sales address',
      directMembersCount: '2',
      aliases: ['orders@optiwork.ai'],
      adminCreated: true,
    });
    expect(JSON.stringify(out)).not.toContain('etag');
  });

  it('caps at Google\'s own ceiling of 200 rather than sending a number it rejects', async () => {
    await ok(capture(registerListGroups).handler, { account: ADMIN, max_results: 1000 });
    expect(directoryApi.groups.list).toHaveBeenCalledWith(expect.objectContaining({ maxResults: 200 }));
  });

  it('asks by user when user_key is given, and sends no customer or domain with it', async () => {
    await ok(capture(registerListGroups).handler, { account: ADMIN, user_key: 'emma@optiwork.ai' });
    const sent = directoryApi.groups.list.mock.calls[0][0] as Record<string, unknown>;
    expect(sent.userKey).toBe('emma@optiwork.ai');
    expect(sent).not.toHaveProperty('customer');
    expect(sent).not.toHaveProperty('domain');
  });
});

describe('get_group', () => {
  beforeEach(() => {
    directoryApi.groups.get.mockResolvedValue({ data: RAW_GROUP });
    settingsApi.groups.get.mockResolvedValue({ data: RAW_SETTINGS });
    directoryApi.members.list.mockResolvedValue({
      data: {
        members: [{ email: 'a@optiwork.ai', role: 'OWNER', type: 'USER', status: 'ACTIVE', etag: 'noise' }],
        nextPageToken: null,
      },
    });
  });

  it('shows the whole posture: the group, its settings and its members', async () => {
    const out = await ok(capture(registerGetGroup).handler, { account: ADMIN, group_key: 'sales@optiwork.ai' });

    expect(out.group).toMatchObject({ email: 'sales@optiwork.ai', name: 'Sales' });
    expect(out.settings).toMatchObject({
      who_can_post_message: 'ANYONE_CAN_POST',
      allow_external_members: true,
    });
    expect(out.members).toEqual([
      { email: 'a@optiwork.ai', role: 'OWNER', type: 'USER', status: 'ACTIVE' },
    ]);
    expect(out.settings).not.toHaveProperty('maxMessageBytes');
  });

  it('reads the settings by the group\'s ADDRESS even when it was asked for by id', async () => {
    // Groups Settings is keyed on the email address and nothing else; an id
    // that works perfectly well for the Directory call is a 404 there.
    await ok(capture(registerGetGroup).handler, { account: ADMIN, group_key: '01abc' });
    expect(settingsApi.groups.get).toHaveBeenCalledWith({ groupUniqueId: 'sales@optiwork.ai' });
  });

  it('says when there are more members than it fetched, instead of implying that is all of them', async () => {
    directoryApi.members.list.mockResolvedValue({
      data: { members: [{ email: 'a@optiwork.ai' }], nextPageToken: 'more-members' },
    });
    const out = await ok(capture(registerGetGroup).handler, { account: ADMIN, group_key: 'sales@optiwork.ai' });
    expect(out.members_truncated).toBe(true);
  });

  it('does not claim a truncation that did not happen', async () => {
    const out = await ok(capture(registerGetGroup).handler, { account: ADMIN, group_key: 'sales@optiwork.ai' });
    expect(out.members_truncated).toBeUndefined();
  });

  it('still returns the group when the settings API is off, and says so out loud', async () => {
    // Losing the whole answer because a second API is switched off would be
    // worse than saying which half is missing — but a silent absence would be
    // worse still, because "no settings" reads as "no restrictions".
    settingsApi.groups.get.mockRejectedValue(
      googleError(403, 'accessNotConfigured', 'Groups Settings API has not been used in project 1 before or it is disabled.'),
    );
    const out = await ok(capture(registerGetGroup).handler, { account: ADMIN, group_key: 'sales@optiwork.ai' });

    expect(out.group).toMatchObject({ email: 'sales@optiwork.ai' });
    expect(out.settings).toBeNull();
    expect(String(out.settings_error)).toMatch(/not enabled/i);
  });

  it('fails the whole call when the GROUP itself cannot be read', async () => {
    directoryApi.groups.get.mockRejectedValue(googleError(404, 'notFound', 'Resource Not Found: groupKey'));
    const text = await fails(capture(registerGetGroup).handler, { account: ADMIN, group_key: 'nope@optiwork.ai' });
    expect(text).toMatch(/no such group/i);
    expect(text).toContain('nope@optiwork.ai');
  });
});

// ---------------------------------------------------------------------------
// create_group — three steps, and the result says which of them happened
// ---------------------------------------------------------------------------

describe('create_group', () => {
  const sleep = vi.fn(async (_ms: number) => undefined);

  beforeEach(() => {
    sleep.mockClear();
    directoryApi.groups.insert.mockResolvedValue({ data: RAW_GROUP });
    settingsApi.groups.patch.mockResolvedValue({ data: RAW_SETTINGS });
    directoryApi.members.insert.mockResolvedValue({
      data: { email: 'crm@appraisalhostmail.com', role: 'MEMBER', type: 'USER', status: 'ACTIVE' },
    });
  });

  /**
   * What a caller sends. `sleep` is NOT among them: it is an option on
   * createGroup, never a tool parameter, because a function in a tool's schema
   * cannot be turned into JSON Schema and would break the whole roster's
   * listing. The two retry tests below therefore call createGroup directly, the
   * way src/calendar/client.test.ts calls createEvent.
   */
  const args = {
    account: ADMIN,
    email: 'sales@optiwork.ai',
    name: 'Sales',
    settings: { who_can_post_message: 'ANYONE_CAN_POST', allow_external_members: true },
    members: [{ email: 'crm@appraisalhostmail.com' }],
  };

  it('creates, then applies settings, then adds members — in that order', async () => {
    const order: string[] = [];
    directoryApi.groups.insert.mockImplementation(async () => { order.push('insert'); return { data: RAW_GROUP }; });
    settingsApi.groups.patch.mockImplementation(async () => { order.push('settings'); return { data: RAW_SETTINGS }; });
    directoryApi.members.insert.mockImplementation(async () => { order.push('member'); return { data: { email: 'crm@appraisalhostmail.com', role: 'MEMBER' } }; });

    const out = await ok(capture(registerCreateGroup).handler, args);

    // Settings BEFORE members is load-bearing, not tidiness: an address outside
    // the domain — the CRM's inbound mailbox, which is the whole point here —
    // cannot be added until allowExternalMembers is true.
    expect(order).toEqual(['insert', 'settings', 'member']);
    expect(out.settings_applied).toBe(true);
    expect(out.members_added).toEqual(['crm@appraisalhostmail.com']);
    expect(out.members_failed).toEqual([]);
  });

  it('sends the group Google actually needs, and the settings as Google spells them', async () => {
    await ok(capture(registerCreateGroup).handler, { ...args, description: 'the sales address' });

    expect(directoryApi.groups.insert).toHaveBeenCalledWith({
      requestBody: { email: 'sales@optiwork.ai', name: 'Sales', description: 'the sales address' },
    });
    expect(settingsApi.groups.patch).toHaveBeenCalledWith({
      groupUniqueId: 'sales@optiwork.ai',
      requestBody: { whoCanPostMessage: 'ANYONE_CAN_POST', allowExternalMembers: 'true' },
    });
  });

  it('says "not requested" rather than "false" when no settings were passed', async () => {
    const out = await ok(capture(registerCreateGroup).handler, {
      account: ADMIN, email: 'sales@optiwork.ai', name: 'Sales',
    });
    expect(out.settings_applied).toBe('not requested');
    expect(settingsApi.groups.patch).not.toHaveBeenCalled();
  });

  it('waits out the seconds a brand-new group is invisible to the settings API', async () => {
    // Eventual consistency, and the failure it produces is a 404 on a group
    // that certainly exists. Retrying is the fix; giving up would report a
    // group created with none of the settings that were the reason for it.
    settingsApi.groups.patch
      .mockRejectedValueOnce(googleError(404, 'notFound', 'Resource Not Found'))
      .mockRejectedValueOnce(googleError(404, 'notFound', 'Resource Not Found'))
      .mockResolvedValue({ data: RAW_SETTINGS });

    const out = await createGroup({ ...args, sleep });

    expect(out.settings_applied).toBe(true);
    expect(sleep.mock.calls.map(c => c[0])).toEqual(GROUP_SETTINGS_RETRY_DELAYS_MS.slice(0, 2));
  });

  it('gives up honestly after the last retry, and still reports the group it made', async () => {
    settingsApi.groups.patch.mockRejectedValue(googleError(404, 'notFound', 'Resource Not Found'));

    const out = await createGroup({ ...args, sleep });

    expect(out.group).toMatchObject({ email: 'sales@optiwork.ai' });
    expect(out.settings_applied).toBe(false);
    expect(String(out.settings_error)).toMatch(/no such group|not found/i);
    expect(sleep).toHaveBeenCalledTimes(GROUP_SETTINGS_RETRY_DELAYS_MS.length);
    // The group is NOT rolled back. Saying so is the honest thing, because the
    // address exists and mail will start arriving at it.
    expect(String(out.note)).toMatch(/still exists|was created/i);
  });

  it('reports each member that failed, by address, without losing the ones that worked', async () => {
    directoryApi.members.insert
      .mockResolvedValueOnce({ data: { email: 'a@optiwork.ai', role: 'MEMBER' } })
      .mockRejectedValueOnce(googleError(400, 'invalid', 'Invalid Input: memberKey'));

    const out = await ok(capture(registerCreateGroup).handler, {
      ...args,
      members: [{ email: 'a@optiwork.ai' }, { email: 'nope@elsewhere.test' }],
    });

    expect(out.members_added).toEqual(['a@optiwork.ai']);
    expect(out.members_failed).toEqual([
      { email: 'nope@elsewhere.test', error: expect.stringContaining('Invalid Input') },
    ]);
  });

  it('never retries the create itself, and says the group may exist if the answer was a 5xx', async () => {
    directoryApi.groups.insert.mockRejectedValue(googleError(503, 'backendError', 'Service Unavailable'));

    const text = await fails(capture(registerCreateGroup).handler, args);

    expect(directoryApi.groups.insert).toHaveBeenCalledTimes(1);
    expect(text).toMatch(/may already exist/i);
    expect(text).toContain('get_group');
  });

  it('says "already exists" for a group that is already there, and creates nothing', async () => {
    directoryApi.groups.insert.mockRejectedValue(googleError(409, 'duplicate', 'Entity already exists.'));
    const text = await fails(capture(registerCreateGroup).handler, args);
    expect(text).toMatch(/already a group/i);
    expect(settingsApi.groups.patch).not.toHaveBeenCalled();
  });

  it('spells out the recipe for accepting outside mail in the settings description', () => {
    const { description } = capture(registerCreateGroup);
    expect(description).toMatch(/free/i);
    expect(description).toMatch(/no licence|no license|does not cost/i);
  });
});

// ---------------------------------------------------------------------------
// The other group writes
// ---------------------------------------------------------------------------

describe('update_group_settings', () => {
  beforeEach(() => {
    settingsApi.groups.patch.mockResolvedValue({ data: RAW_SETTINGS });
    settingsApi.groups.get.mockResolvedValue({
      data: { ...RAW_SETTINGS, includeInGlobalAddressList: 'false' },
    });
    directoryApi.groups.get.mockResolvedValue({ data: RAW_GROUP });
  });

  it('patches only what was passed, then RE-READS so the answer is Google\'s, not ours', async () => {
    const out = await ok(capture(registerUpdateGroupSettings).handler, {
      account: ADMIN,
      group_key: 'sales@optiwork.ai',
      settings: { include_in_global_address_list: false },
    });

    expect(settingsApi.groups.patch).toHaveBeenCalledWith({
      groupUniqueId: 'sales@optiwork.ai',
      requestBody: { includeInGlobalAddressList: 'false' },
    });
    expect(settingsApi.groups.get).toHaveBeenCalledWith({ groupUniqueId: 'sales@optiwork.ai' });
    expect(out.settings).toMatchObject({ include_in_global_address_list: false });
  });

  it('refuses an empty settings object rather than sending a patch that changes nothing', async () => {
    const text = await fails(capture(registerUpdateGroupSettings).handler, {
      account: ADMIN, group_key: 'sales@optiwork.ai', settings: {},
    });
    expect(text).toMatch(/at least one/i);
    expect(settingsApi.groups.patch).not.toHaveBeenCalled();
  });

  it('refuses a setting it does not write, naming it', async () => {
    const text = await fails(capture(registerUpdateGroupSettings).handler, {
      account: ADMIN, group_key: 'sales@optiwork.ai', settings: { who_can_add_references: 'NONE' },
    });
    expect(text).toContain('who_can_add_references');
    expect(settingsApi.groups.patch).not.toHaveBeenCalled();
  });
});

describe('delete_group', () => {
  beforeEach(() => {
    directoryApi.groups.delete.mockResolvedValue({ data: undefined });
  });

  it('is REFUSED without confirm: true, and deletes nothing', async () => {
    const text = await fails(capture(registerDeleteGroup).handler, {
      account: ADMIN, group_key: 'sales@optiwork.ai',
    });
    expect(text).toMatch(/confirm/i);
    expect(directoryApi.groups.delete).not.toHaveBeenCalled();
  });

  it('deletes with confirm: true', async () => {
    const out = await ok(capture(registerDeleteGroup).handler, {
      account: ADMIN, group_key: 'sales@optiwork.ai', confirm: true,
    });
    expect(directoryApi.groups.delete).toHaveBeenCalledWith({ groupKey: 'sales@optiwork.ai' });
    expect(out.deleted).toBe('sales@optiwork.ai');
  });

  it('says in its description that mail to the address will bounce and there is no undo', () => {
    const { description } = capture(registerDeleteGroup);
    expect(description).toMatch(/bounce/i);
    expect(description).toMatch(/no undo|cannot be undone/i);
    expect(description).toMatch(/refused/i);
  });
});

describe('add_group_alias', () => {
  it('adds the alias to the group', async () => {
    directoryApi.groups.aliases.insert.mockResolvedValue({ data: { alias: 'orders@optiwork.ai' } });
    const out = await ok(capture(registerAddGroupAlias).handler, {
      account: ADMIN, group_key: 'sales@optiwork.ai', alias: 'orders@optiwork.ai',
    });
    expect(directoryApi.groups.aliases.insert).toHaveBeenCalledWith({
      groupKey: 'sales@optiwork.ai',
      requestBody: { alias: 'orders@optiwork.ai' },
    });
    expect(out.alias).toBe('orders@optiwork.ai');
  });
});

describe('add_group_member / remove_group_member', () => {
  beforeEach(() => {
    directoryApi.members.insert.mockResolvedValue({
      data: { email: 'crm@appraisalhostmail.com', role: 'MEMBER', type: 'USER', status: 'ACTIVE' },
    });
    directoryApi.members.delete.mockResolvedValue({ data: undefined });
  });

  it('adds a member as MEMBER by default', async () => {
    const out = await ok(byName(registerGroupMemberTools, 'add_group_member').handler, {
      account: ADMIN, group_key: 'sales@optiwork.ai', email: 'crm@appraisalhostmail.com',
    });
    expect(directoryApi.members.insert).toHaveBeenCalledWith({
      groupKey: 'sales@optiwork.ai',
      requestBody: { email: 'crm@appraisalhostmail.com', role: 'MEMBER' },
    });
    expect(out.member).toMatchObject({ email: 'crm@appraisalhostmail.com', role: 'MEMBER' });
  });

  it('passes a role and a delivery preference under the names Google uses', async () => {
    await ok(byName(registerGroupMemberTools, 'add_group_member').handler, {
      account: ADMIN, group_key: 'sales@optiwork.ai', email: 'a@optiwork.ai',
      role: 'MANAGER', delivery_settings: 'DIGEST',
    });
    expect(directoryApi.members.insert).toHaveBeenCalledWith({
      groupKey: 'sales@optiwork.ai',
      // Google's own field really is snake_case here, alone among these.
      requestBody: { email: 'a@optiwork.ai', role: 'MANAGER', delivery_settings: 'DIGEST' },
    });
  });

  it('says "already" when the address is already a member', async () => {
    directoryApi.members.insert.mockRejectedValue(googleError(409, 'duplicate', 'Member already exists.'));
    const text = await fails(byName(registerGroupMemberTools, 'add_group_member').handler, {
      account: ADMIN, group_key: 'sales@optiwork.ai', email: 'a@optiwork.ai',
    });
    expect(text).toMatch(/already a group member/i);
  });

  it('names update_group_settings when Google refuses an address outside the domain', async () => {
    directoryApi.members.insert.mockRejectedValue(
      googleError(400, 'invalid', 'Invalid Input: memberKey — external members are not allowed'),
    );
    const text = await fails(byName(registerGroupMemberTools, 'add_group_member').handler, {
      account: ADMIN, group_key: 'sales@optiwork.ai', email: 'crm@appraisalhostmail.com',
    });
    expect(text).toContain('update_group_settings');
    expect(text).toMatch(/allow_external_members/);
  });

  it('removes a member', async () => {
    const out = await ok(byName(registerGroupMemberTools, 'remove_group_member').handler, {
      account: ADMIN, group_key: 'sales@optiwork.ai', email: 'a@optiwork.ai',
    });
    expect(directoryApi.members.delete).toHaveBeenCalledWith({
      groupKey: 'sales@optiwork.ai', memberKey: 'a@optiwork.ai',
    });
    expect(out.removed).toBe('a@optiwork.ai');
  });
});

// ---------------------------------------------------------------------------
// The user writes — the ones that cost money
// ---------------------------------------------------------------------------

describe('create_workspace_user', () => {
  beforeEach(() => {
    directoryApi.users.insert.mockResolvedValue({ data: RAW_USER });
  });

  const args = {
    account: ADMIN,
    primary_email: 'emma.clarke@optiwork.ai',
    given_name: 'Emma',
    family_name: 'Clarke',
    confirm: true,
  };

  it('is REFUSED without confirm: true, and creates nothing', async () => {
    const text = await fails(capture(registerCreateWorkspaceUser).handler, { ...args, confirm: undefined });
    expect(text).toMatch(/confirm/i);
    expect(directoryApi.users.insert).not.toHaveBeenCalled();
  });

  it('says in its description that this adds a PAID monthly seat', () => {
    const { description } = capture(registerCreateWorkspaceUser);
    expect(description).toMatch(/paid/i);
    expect(description).toMatch(/seat|licen/i);
    expect(description).toMatch(/every month|monthly/i);
    expect(description).toMatch(/refused/i);
  });

  it('mints a password when none was given, returns it ONCE, and forces a change at first login', async () => {
    const out = await ok(capture(registerCreateWorkspaceUser).handler, args);

    const sent = directoryApi.users.insert.mock.calls[0][0] as { requestBody: Record<string, unknown> };
    expect(typeof sent.requestBody.password).toBe('string');
    expect(String(sent.requestBody.password).length).toBeGreaterThanOrEqual(20);
    expect(sent.requestBody.changePasswordAtNextLogin).toBe(true);
    expect(out.initial_password).toBe(sent.requestBody.password);
    expect(String(out.note)).toMatch(/only place|shown once|will not be shown again/i);
  });

  it('never writes the password to the log', async () => {
    const out = await ok(capture(registerCreateWorkspaceUser).handler, args);
    const password = String(out.initial_password);

    expect(logCalls.length).toBeGreaterThan(0);
    expect(JSON.stringify(logCalls)).not.toContain(password);
    // And nothing that looks like a password field, either.
    expect(JSON.stringify(logCalls)).not.toMatch(/"password"/);
  });

  it('does not echo back a password the caller supplied', async () => {
    const out = await ok(capture(registerCreateWorkspaceUser).handler, {
      ...args, password: 'chosen-by-the-caller-12345',
    });
    expect(out.initial_password).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain('chosen-by-the-caller-12345');
    expect(JSON.stringify(logCalls)).not.toContain('chosen-by-the-caller-12345');
  });

  it('still forces a password change unless the caller says otherwise', async () => {
    const { handler } = capture(registerCreateWorkspaceUser);
    await ok(handler, { ...args, password: 'chosen-by-the-caller-12345' });
    expect((directoryApi.users.insert.mock.calls[0][0] as { requestBody: Record<string, unknown> })
      .requestBody.changePasswordAtNextLogin).toBe(true);

    await ok(handler, { ...args, password: 'chosen-by-the-caller-12345', change_password_at_next_login: false });
    expect((directoryApi.users.insert.mock.calls[1][0] as { requestBody: Record<string, unknown> })
      .requestBody.changePasswordAtNextLogin).toBe(false);
  });

  it('never retries the insert, because a retry is a second person and a second seat', async () => {
    directoryApi.users.insert.mockRejectedValue(googleError(503, 'backendError', 'Service Unavailable'));
    const text = await fails(capture(registerCreateWorkspaceUser).handler, args);

    expect(directoryApi.users.insert).toHaveBeenCalledTimes(1);
    expect(text).toMatch(/may already exist/i);
    expect(text).toContain('get_workspace_user');
  });
});

describe('generateInitialPassword', () => {
  it('is long and mixes the classes a Workspace policy asks for', () => {
    for (let i = 0; i < 20; i += 1) {
      const password = generateInitialPassword();
      expect(password.length).toBeGreaterThanOrEqual(20);
      expect(password).toMatch(/[a-z]/);
      expect(password).toMatch(/[A-Z]/);
      expect(password).toMatch(/[0-9]/);
      expect(password).toMatch(/[^A-Za-z0-9]/);
    }
  });

  it('is different every time', () => {
    const seen = new Set(Array.from({ length: 50 }, () => generateInitialPassword()));
    expect(seen.size).toBe(50);
  });
});

describe('update_workspace_user', () => {
  beforeEach(() => {
    directoryApi.users.patch.mockResolvedValue({ data: RAW_USER });
  });

  it('PATCHES only the fields it was given — never a whole user record', async () => {
    // users.update replaces the record. Sending it a partial body would blank
    // everything the caller did not restate.
    const out = await ok(capture(registerUpdateWorkspaceUser).handler, {
      account: ADMIN, user_key: 'emma.clarke@optiwork.ai', given_name: 'Em', org_unit_path: '/Staff',
    });

    expect(directoryApi.users.patch).toHaveBeenCalledWith({
      userKey: 'emma.clarke@optiwork.ai',
      requestBody: { name: { givenName: 'Em' }, orgUnitPath: '/Staff' },
    });
    expect(out.fields_changed).toEqual(['given_name', 'org_unit_path']);
  });

  it('refuses a call that changes nothing', async () => {
    const text = await fails(capture(registerUpdateWorkspaceUser).handler, {
      account: ADMIN, user_key: 'emma.clarke@optiwork.ai',
    });
    expect(text).toMatch(/at least one/i);
    expect(directoryApi.users.patch).not.toHaveBeenCalled();
  });

  it('REFUSES to suspend without confirm: true — that one locks a person out', async () => {
    const text = await fails(capture(registerUpdateWorkspaceUser).handler, {
      account: ADMIN, user_key: 'emma.clarke@optiwork.ai', suspended: true,
    });
    expect(text).toMatch(/confirm/i);
    expect(directoryApi.users.patch).not.toHaveBeenCalled();
  });

  it('lets a person back IN without a confirmation, because that undoes harm rather than doing it', async () => {
    await ok(capture(registerUpdateWorkspaceUser).handler, {
      account: ADMIN, user_key: 'emma.clarke@optiwork.ai', suspended: false,
    });
    expect(directoryApi.users.patch).toHaveBeenCalledWith({
      userKey: 'emma.clarke@optiwork.ai',
      requestBody: { suspended: false },
    });
  });

  it('suspends with confirm: true', async () => {
    await ok(capture(registerUpdateWorkspaceUser).handler, {
      account: ADMIN, user_key: 'emma.clarke@optiwork.ai', suspended: true, confirm: true,
    });
    expect(directoryApi.users.patch).toHaveBeenCalledWith({
      userKey: 'emma.clarke@optiwork.ai',
      requestBody: { suspended: true },
    });
  });
});

describe('add_user_alias', () => {
  it('adds the alias to the user', async () => {
    directoryApi.users.aliases.insert.mockResolvedValue({ data: { alias: 'emma@optiwork.ai' } });
    const out = await ok(capture(registerAddUserAlias).handler, {
      account: ADMIN, user_key: 'emma.clarke@optiwork.ai', alias: 'emma@optiwork.ai',
    });
    expect(directoryApi.users.aliases.insert).toHaveBeenCalledWith({
      userKey: 'emma.clarke@optiwork.ai',
      requestBody: { alias: 'emma@optiwork.ai' },
    });
    expect(out.alias).toBe('emma@optiwork.ai');
  });
});

// ---------------------------------------------------------------------------
// What the log carries
// ---------------------------------------------------------------------------

describe('what a write writes down', () => {
  it('logs the tool, the account, the target and the field NAMES — never the values', async () => {
    settingsApi.groups.patch.mockResolvedValue({ data: RAW_SETTINGS });
    settingsApi.groups.get.mockResolvedValue({ data: RAW_SETTINGS });

    await ok(capture(registerUpdateGroupSettings).handler, {
      account: ADMIN,
      group_key: 'sales@optiwork.ai',
      settings: { who_can_post_message: 'ANYONE_CAN_POST', allow_external_members: true },
    });

    const entry = logCalls.find(l => l.message === 'update_group_settings');
    expect(entry?.fields).toMatchObject({
      account: 'steve-optiwork',
      group: 'sales@optiwork.ai',
      settings: ['who_can_post_message', 'allow_external_members'],
    });
  });
});

// ---------------------------------------------------------------------------
// Which writes may be retried, and which must never be
// ---------------------------------------------------------------------------

describe('the retry policy', () => {
  /** googleapis' shape for a gateway failure, which withRetry retries. */
  function serverError(): Error {
    return Object.assign(new Error('Service Unavailable'), {
      code: 503,
      errors: [{ reason: 'backendError' }],
      response: { status: 503, data: { error: { errors: [{ reason: 'backendError' }] } } },
    });
  }

  it('never retries a CREATE or a DELETE — a retry makes a second one', async () => {
    // The whole argument in one place: a gateway timeout can arrive after
    // Google has done the thing. A second group is untidy; a second USER is a
    // second paid seat every month.
    const cases: Array<[string, Register, string, Record<string, unknown>, { mockClear(): void; mock: { calls: unknown[] }; mockRejectedValue(v: unknown): void }]> = [
      ['create_group', registerCreateGroup, 'create_group', { email: 'g@optiwork.ai', name: 'G' }, directoryApi.groups.insert],
      ['delete_group', registerDeleteGroup, 'delete_group', { group_key: 'g@optiwork.ai', confirm: true }, directoryApi.groups.delete],
      ['add_group_member', registerGroupMemberTools, 'add_group_member', { group_key: 'g@optiwork.ai', email: 'a@optiwork.ai' }, directoryApi.members.insert],
      ['remove_group_member', registerGroupMemberTools, 'remove_group_member', { group_key: 'g@optiwork.ai', email: 'a@optiwork.ai' }, directoryApi.members.delete],
      ['create_workspace_user', registerCreateWorkspaceUser, 'create_workspace_user', { primary_email: 'a@optiwork.ai', given_name: 'A', family_name: 'B', confirm: true }, directoryApi.users.insert],
    ];

    for (const [label, register, name, args, mock] of cases) {
      mock.mockClear();
      mock.mockRejectedValue(serverError());
      await fails(byName(register, name).handler, { ...args, account: ADMIN });
      expect(mock.mock.calls.length, `${label} was attempted more than once`).toBe(1);
    }
  });

  it('DOES retry the writes that are safe to repeat, and succeeds on the second go', async () => {
    // An alias insert, a settings patch and a user patch all leave Google in
    // the same state whether they run once or twice, so a gateway timeout is
    // worth another go rather than being reported as a failure that worked.
    //
    // One rejection then a success, rather than exhausting the whole retry
    // budget: it proves the same thing and spends one backoff instead of
    // twenty seconds of real sleeping.
    const cases: Array<[string, Register, string, Record<string, unknown>, {
      mockClear(): void;
      mock: { calls: unknown[] };
      mockRejectedValueOnce(v: unknown): { mockResolvedValue(v: unknown): void };
    }]> = [
      ['add_group_alias', registerAddGroupAlias, 'add_group_alias', { group_key: 'g@optiwork.ai', alias: 'x@optiwork.ai' }, directoryApi.groups.aliases.insert],
      ['add_user_alias', registerAddUserAlias, 'add_user_alias', { user_key: 'a@optiwork.ai', alias: 'x@optiwork.ai' }, directoryApi.users.aliases.insert],
      ['update_workspace_user', registerUpdateWorkspaceUser, 'update_workspace_user', { user_key: 'a@optiwork.ai', given_name: 'A' }, directoryApi.users.patch],
    ];

    for (const [label, register, name, args, mock] of cases) {
      mock.mockClear();
      mock.mockRejectedValueOnce(serverError()).mockResolvedValue({ data: { alias: 'x@optiwork.ai', ...RAW_USER } });
      await ok(byName(register, name).handler, { ...args, account: ADMIN });
      expect(mock.mock.calls.length, `${label} gave up after one attempt`).toBe(2);
    }
  }, 20_000);
});
