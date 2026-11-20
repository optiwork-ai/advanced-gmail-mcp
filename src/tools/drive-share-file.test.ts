/**
 * GM-SHARE-1 unit U1 — share_drive_file.
 *
 * Pins what is sent to Google (one `permissions.create` per person, always a
 * `type: "user"` grant, never a notification email), the refusals that happen
 * before any network call, and how each answer from Google turns into a
 * per-person status. `googleapis`, the OAuth client, the account config and the
 * logger are all mocked: nothing here touches a token, a real Drive or a
 * real person's access.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = {
  permissions: { create: vi.fn(), list: vi.fn(), delete: vi.fn(), update: vi.fn() },
  files: { create: vi.fn(), update: vi.fn(), delete: vi.fn() },
};

/** Anything carrying this string reaching the output or the log is a leak. */
const SENTINEL = 'ya29.SENTINEL-token-that-must-never-surface';

vi.mock('googleapis', () => ({
  google: { drive: () => api },
}));

vi.mock('../gmail/auth.js', () => ({
  getAuthClient: vi.fn(async () => ({
    credentials: { access_token: SENTINEL },
    headers: { Authorization: `Bearer ${SENTINEL}` },
  })),
}));

vi.mock('../config.js', () => ({
  resolveAccount: (input?: string) => ({ alias: input ?? 'work', email: 'owner@example.com' }),
}));

const logCalls: { level: string; message: string; fields: Record<string, unknown> }[] = [];
vi.mock('../log.js', () => ({
  log: (level: string, message: string, fields: Record<string, unknown> = {}) => {
    logCalls.push({ level, message, fields });
  },
}));

const { registerShareDriveFile } = await import('./drive-share-file.js');

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function capture(): { name: string; description: string; handler: Handler } {
  let captured: { name: string; description: string; handler: Handler } | undefined;
  const server = {
    tool: (name: string, description: string, _params: unknown, handler: Handler) => {
      captured = { name, description, handler };
    },
  };
  registerShareDriveFile(server as never);
  if (!captured) throw new Error('the tool registered nothing');
  return captured;
}

async function call(args: Record<string, unknown>) {
  const res = await capture().handler(args);
  const text = res.content[0].text;
  const body = res.isError ? undefined : JSON.parse(text);
  return { res, text, body };
}

/** A Google API failure in the shape gaxios throws. */
function googleError(code: number, message: string, reason?: string): Error {
  const err = new Error(message) as Error & { code: number; errors?: Array<{ reason: string; message: string }> };
  err.code = code;
  if (reason) err.errors = [{ reason, message }];
  return err;
}

const OWNER = { id: 'p-owner', type: 'user', role: 'owner', emailAddress: 'owner@example.com' };

function page(permissions: unknown[], nextPageToken?: string) {
  return { data: { permissions, ...(nextPageToken ? { nextPageToken } : {}) } };
}

function created(id: string) {
  return { data: { id } };
}

const A = { email: 'a@example.com', role: 'reader' };
const B = { email: 'b@example.com', role: 'writer' };
const C = { email: 'c@example.com', role: 'commenter' };

beforeEach(() => {
  vi.clearAllMocks();
  logCalls.length = 0;
});

describe('share_drive_file — what is sent to Google', () => {
  it('T2: one create per person in order, each with notification OFF and a body of exactly type/role/emailAddress, then one read-back', async () => {
    api.permissions.create
      .mockResolvedValueOnce(created('p-a'))
      .mockResolvedValueOnce(created('p-b'));
    api.permissions.list.mockResolvedValue(page([
      OWNER,
      { id: 'p-a', type: 'user', role: 'reader', emailAddress: 'a@example.com' },
      { id: 'p-b', type: 'user', role: 'writer', emailAddress: 'b@example.com' },
    ]));

    const { res, body } = await call({ file_id: 'file-1', recipients: [A, B] });

    expect(res.isError).toBeUndefined();
    expect(api.permissions.create).toHaveBeenCalledTimes(2);
    const [first, second] = api.permissions.create.mock.calls.map(c => c[0]);
    for (const [args, who] of [[first, A], [second, B]] as const) {
      expect(args.fileId).toBe('file-1');
      expect(args.sendNotificationEmail).toBe(false);
      expect(args.requestBody).toEqual({ type: 'user', role: who.role, emailAddress: who.email });
      expect(args).not.toHaveProperty('emailMessage');
      expect(args).not.toHaveProperty('transferOwnership');
      expect(args).not.toHaveProperty('moveToNewOwnersRoot');
      expect(args.requestBody).not.toHaveProperty('allowFileDiscovery');
    }

    expect(api.permissions.list).toHaveBeenCalledTimes(1);
    expect(api.permissions.list.mock.calls[0][0].fileId).toBe('file-1');
    const lastCreate = Math.max(...api.permissions.create.mock.invocationCallOrder);
    expect(api.permissions.list.mock.invocationCallOrder[0]).toBeGreaterThan(lastCreate);

    expect(body.success).toBe(true);
    expect(body.fileId).toBe('file-1');
    expect(body.account).toBe('work');
    expect(body.results).toEqual([
      { email: 'a@example.com', role: 'reader', status: 'granted', permissionId: 'p-a' },
      { email: 'b@example.com', role: 'writer', status: 'granted', permissionId: 'p-b' },
    ]);
    expect(body.permissions).toHaveLength(3);

    // Nothing but permissions.create and permissions.list was touched.
    expect(api.permissions.delete).not.toHaveBeenCalled();
    expect(api.permissions.update).not.toHaveBeenCalled();
    expect(api.files.update).not.toHaveBeenCalled();
  });

  it('T3: all three roles pass through unchanged', async () => {
    api.permissions.create
      .mockResolvedValueOnce(created('p-a'))
      .mockResolvedValueOnce(created('p-b'))
      .mockResolvedValueOnce(created('p-c'));
    api.permissions.list.mockResolvedValue(page([
      OWNER,
      { id: 'p-a', type: 'user', role: 'reader', emailAddress: 'a@example.com' },
      { id: 'p-b', type: 'user', role: 'writer', emailAddress: 'b@example.com' },
      { id: 'p-c', type: 'user', role: 'commenter', emailAddress: 'c@example.com' },
    ]));

    const { body } = await call({ file_id: 'file-1', recipients: [A, B, C] });

    expect(api.permissions.create.mock.calls.map(c => c[0].requestBody.role))
      .toEqual(['reader', 'writer', 'commenter']);
    expect(body.results.map((r: { status: string }) => r.status)).toEqual(['granted', 'granted', 'granted']);
  });
});

describe('share_drive_file — refusals before any Google call', () => {
  const refusals: Array<[string, Record<string, unknown>]> = [
    ['a recipient carrying type "anyone"', { file_id: 'file-1', recipients: [{ ...A, type: 'anyone' }] }],
    ['a recipient carrying type "domain"', { file_id: 'file-1', recipients: [{ ...A, type: 'domain' }] }],
    ['a recipient carrying type "group"', { file_id: 'file-1', recipients: [{ ...A, type: 'group' }] }],
    ['a recipient carrying a domain key', { file_id: 'file-1', recipients: [{ ...A, domain: 'example.com' }] }],
    ['role owner', { file_id: 'file-1', recipients: [{ email: 'a@example.com', role: 'owner' }] }],
    ['role organizer', { file_id: 'file-1', recipients: [{ email: 'a@example.com', role: 'organizer' }] }],
    ['an empty role', { file_id: 'file-1', recipients: [{ email: 'a@example.com', role: '' }] }],
    ['empty recipients', { file_id: 'file-1', recipients: [] }],
    ['an empty file id', { file_id: '   ', recipients: [A] }],
    ['an email without @', { file_id: 'file-1', recipients: [{ email: 'a.example.com', role: 'reader' }] }],
    ['an email with a display name', { file_id: 'file-1', recipients: [{ email: 'Pat <pat@example.com>', role: 'reader' }] }],
    ['two addresses in one string', { file_id: 'file-1', recipients: [{ email: 'a@example.com, b@example.com', role: 'reader' }] }],
    ['the same address twice in different case', { file_id: 'file-1', recipients: [A, { email: 'A@Example.COM', role: 'writer' }] }],
  ];

  it.each(refusals)('T4: refuses %s with zero Drive calls', async (_label, args) => {
    const { res, text } = await call(args);

    expect(res.isError).toBe(true);
    expect(text).toMatch(/^Error: share_drive_file/);
    expect(api.permissions.create).not.toHaveBeenCalled();
    expect(api.permissions.list).not.toHaveBeenCalled();
  });

  it('T4: the refusal names the item and the rule', async () => {
    const { text } = await call({ file_id: 'file-1', recipients: [A, { email: 'b@example.com', role: 'owner' }] });
    expect(text).toContain('recipients[1]');
    expect(text).toMatch(/reader, commenter or writer/);
  });

  it('T5: one valid and one invalid recipient — nothing is shared with either', async () => {
    const { res } = await call({ file_id: 'file-1', recipients: [A, { email: 'nobody', role: 'reader' }] });

    expect(res.isError).toBe(true);
    expect(api.permissions.create).not.toHaveBeenCalled();
    expect(api.permissions.list).not.toHaveBeenCalled();
  });
});

describe('share_drive_file — failures', () => {
  it('T6: the second of three creates is refused (400): granted, failed with Google\'s words, granted; read-back still runs', async () => {
    api.permissions.create
      .mockResolvedValueOnce(created('p-a'))
      .mockRejectedValueOnce(googleError(400, 'Invalid sharing request: ACL change not allowed.', 'invalidSharingRequest'))
      .mockResolvedValueOnce(created('p-c'));
    api.permissions.list.mockResolvedValue(page([
      OWNER,
      { id: 'p-a', type: 'user', role: 'reader', emailAddress: 'a@example.com' },
      { id: 'p-c', type: 'user', role: 'commenter', emailAddress: 'c@example.com' },
    ]));

    const { res, body } = await call({ file_id: 'file-1', recipients: [A, B, C] });

    expect(res.isError).toBeUndefined();
    expect(api.permissions.create).toHaveBeenCalledTimes(3);
    expect(api.permissions.list).toHaveBeenCalledTimes(1);
    expect(body.success).toBe(false);
    expect(body.results.map((r: { status: string }) => r.status)).toEqual(['granted', 'failed', 'granted']);
    expect(body.results[1].reason).toContain('ACL change not allowed');
  });

  it('T7: a missing scope on the first create names drive.file and the re-consent command, and stops', async () => {
    api.permissions.create.mockRejectedValueOnce(
      googleError(403, 'Request had insufficient authentication scopes.', 'insufficientPermissions'),
    );

    const { res, text } = await call({ file_id: 'file-1', recipients: [A, B] });

    expect(res.isError).toBe(true);
    expect(text).toContain('drive.file');
    expect(text).toContain('npm run auth -- work');
    expect(api.permissions.create).toHaveBeenCalledTimes(1);
  });

  it('T8: a 404 on the first create says the server reaches only files it created, with no re-auth advice, and stops', async () => {
    api.permissions.create.mockRejectedValueOnce(googleError(404, 'File not found: file-1.', 'notFound'));

    const { res, text } = await call({ file_id: 'file-1', recipients: [A, B] });

    expect(res.isError).toBe(true);
    expect(text).toMatch(/only files this server created itself/);
    expect(text).toContain('File not found: file-1.');
    expect(text).not.toMatch(/npm run auth/);
    expect(text).not.toMatch(/Re-authenticate with/);
    expect(api.permissions.create).toHaveBeenCalledTimes(1);
  });

  it('T9: a non-scope 403 on one person fails that person without re-auth advice; the loop continues', async () => {
    api.permissions.create
      .mockRejectedValueOnce(googleError(403, 'The user does not have sufficient permissions for file file-1.', 'insufficientFilePermissions'))
      .mockResolvedValueOnce(created('p-b'));
    api.permissions.list.mockResolvedValue(page([
      OWNER,
      { id: 'p-b', type: 'user', role: 'writer', emailAddress: 'b@example.com' },
    ]));

    const { res, body } = await call({ file_id: 'file-1', recipients: [A, B] });

    expect(res.isError).toBeUndefined();
    expect(api.permissions.create).toHaveBeenCalledTimes(2);
    expect(body.results[0].status).toBe('failed');
    expect(body.results[0].reason).toContain('does not have sufficient permissions');
    expect(body.results[0].reason).not.toMatch(/npm run auth|Re-authenticate with/);
    expect(body.results[1].status).toBe('granted');
    expect(body.success).toBe(false);
  });

  it('T10: a read-back that lacks the created id is unconfirmed, with the reason', async () => {
    api.permissions.create.mockResolvedValueOnce(created('p-a'));
    api.permissions.list.mockResolvedValue(page([OWNER]));

    const { body } = await call({ file_id: 'file-1', recipients: [A] });

    expect(body.results[0].status).toBe('unconfirmed');
    expect(body.results[0].permissionId).toBe('p-a');
    expect(body.results[0].reason).toMatch(/p-a/);
    expect(body.success).toBe(false);
  });

  it('T10: a read-back showing another role is unconfirmed, with the reason', async () => {
    api.permissions.create.mockResolvedValueOnce(created('p-a'));
    api.permissions.list.mockResolvedValue(page([
      OWNER,
      { id: 'p-a', type: 'user', role: 'writer', emailAddress: 'a@example.com' },
    ]));

    const { body } = await call({ file_id: 'file-1', recipients: [A] });

    expect(body.results[0].status).toBe('unconfirmed');
    expect(body.results[0].reason).toMatch(/writer/);
    expect(body.results[0].reason).toMatch(/reader/);
    expect(body.success).toBe(false);
  });

  it('T11: read-back pages are followed and merged', async () => {
    api.permissions.create.mockResolvedValueOnce(created('p-a'));
    api.permissions.list
      .mockResolvedValueOnce(page([OWNER], 'page-2'))
      .mockResolvedValueOnce(page([{ id: 'p-a', type: 'user', role: 'reader', emailAddress: 'a@example.com' }]));

    const { body } = await call({ file_id: 'file-1', recipients: [A] });

    expect(api.permissions.list).toHaveBeenCalledTimes(2);
    expect(api.permissions.list.mock.calls[1][0].pageToken).toBe('page-2');
    expect(body.permissions).toHaveLength(2);
    expect(body.results[0].status).toBe('granted');
    expect(body.success).toBe(true);
  });

  it('T12: a failed read-back after good creates leaves them unconfirmed, never granted', async () => {
    api.permissions.create.mockResolvedValueOnce(created('p-a'));
    api.permissions.list.mockRejectedValueOnce(googleError(400, 'Bad Request'));

    const { res, body } = await call({ file_id: 'file-1', recipients: [A] });

    expect(res.isError).toBeUndefined();
    expect(body.results[0].status).toBe('unconfirmed');
    expect(body.results[0].reason).toMatch(/read-back/);
    expect(body.readBackError).toContain('Bad Request');
    expect(body.success).toBe(false);
  });
});

describe('share_drive_file — what it records and returns', () => {
  it('T13: the log line holds no address; the token never reaches the output or the log', async () => {
    api.permissions.create
      .mockResolvedValueOnce(created('p-a'))
      .mockResolvedValueOnce(created('p-b'));
    api.permissions.list.mockResolvedValue(page([
      OWNER,
      { id: 'p-a', type: 'user', role: 'reader', emailAddress: 'a@example.com' },
      { id: 'p-b', type: 'user', role: 'writer', emailAddress: 'b@example.com' },
    ]));

    const { text } = await call({ file_id: 'file-1', recipients: [A, B] });

    const line = logCalls.find(l => l.message === 'share_drive_file');
    expect(line).toBeDefined();
    const logged = JSON.stringify(line!.fields);
    expect(logged).not.toContain('@');
    expect(logged).not.toContain('a@example.com');
    expect(logged).not.toContain('b@example.com');
    expect(line!.fields).toMatchObject({ account: 'work', file_id: 'file-1' });
    expect(logged).toContain('p-a');
    expect(logged).toContain('reader');

    expect(text).not.toContain(SENTINEL);
    expect(JSON.stringify(logCalls)).not.toContain(SENTINEL);
  });

  it('T14: a pre-existing "anyone" entry is returned as Google gave it, and no such grant is ever sent', async () => {
    const anyone = { id: 'anyoneWithLink', type: 'anyone', role: 'reader' };
    api.permissions.create.mockResolvedValueOnce(created('p-a'));
    api.permissions.list.mockResolvedValue(page([
      OWNER,
      anyone,
      { id: 'p-a', type: 'user', role: 'reader', emailAddress: 'a@example.com' },
    ]));

    const { body } = await call({ file_id: 'file-1', recipients: [A] });

    expect(body.permissions).toContainEqual(anyone);
    for (const [args] of api.permissions.create.mock.calls) {
      expect(args.requestBody.type).toBe('user');
    }
  });

  it('says in its description what it will and will not do', () => {
    const { name, description } = capture();
    expect(name).toBe('share_drive_file');
    expect(description).toMatch(/only files this server created/i);
    expect(description).toMatch(/named people/i);
    expect(description).toMatch(/never turns on link or domain sharing/i);
    expect(description).toMatch(/no Google notification/i);
    expect(description).toMatch(/read-back/i);
    expect(description).toMatch(/undone with unshare_drive_file/);
  });
});
