/**
 * GM-SHARE-1 unit U2 — unshare_drive_file.
 *
 * Pins the one removal path this server has: read the file's list, delete only
 * a named person's own `type: "user"` permission at reader/commenter/writer,
 * matched on the exact address after trimming and lower-casing, then read the
 * list back. Owners, managers, groups, domains and link sharing are never
 * touched. `googleapis`, the OAuth client, the account config and the logger
 * are all mocked: nothing here touches a token, a real Drive or a real
 * person's access.
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

const { registerUnshareDriveFile } = await import('./drive-unshare-file.js');

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
  registerUnshareDriveFile(server as never);
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

function page(permissions: unknown[], nextPageToken?: string) {
  return { data: { permissions, ...(nextPageToken ? { nextPageToken } : {}) } };
}

const OWNER = { id: 'p-owner', type: 'user', role: 'owner', emailAddress: 'owner@example.com' };
const PAT = { id: 'p-pat', type: 'user', role: 'writer', emailAddress: 'pat@example.com' };
const LEE = { id: 'p-lee', type: 'user', role: 'reader', emailAddress: 'lee@example.com' };
const KIM = { id: 'p-kim', type: 'user', role: 'commenter', emailAddress: 'kim@example.com' };

/** Every Drive method a removal must never call. */
function expectNothingButListAndDelete(): void {
  expect(api.permissions.create).not.toHaveBeenCalled();
  expect(api.permissions.update).not.toHaveBeenCalled();
  expect(api.files.create).not.toHaveBeenCalled();
  expect(api.files.update).not.toHaveBeenCalled();
  expect(api.files.delete).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  logCalls.length = 0;
  api.permissions.delete.mockResolvedValue({ data: {} });
});

describe('unshare_drive_file — what is removed', () => {
  it('T15: removes exactly the named person, by id, and reports the role they held', async () => {
    api.permissions.list
      .mockResolvedValueOnce(page([OWNER, PAT, LEE]))
      .mockResolvedValueOnce(page([OWNER, LEE]));

    const { res, body } = await call({ file_id: 'file-1', recipients: ['pat@example.com'] });

    expect(res.isError).toBeUndefined();
    expect(api.permissions.delete).toHaveBeenCalledTimes(1);
    expect(api.permissions.delete.mock.calls[0][0]).toMatchObject({ fileId: 'file-1', permissionId: 'p-pat' });
    expect(api.permissions.list).toHaveBeenCalledTimes(2);
    const deleteAt = api.permissions.delete.mock.invocationCallOrder[0];
    expect(api.permissions.list.mock.invocationCallOrder[0]).toBeLessThan(deleteAt);
    expect(api.permissions.list.mock.invocationCallOrder[1]).toBeGreaterThan(deleteAt);

    expect(body.success).toBe(true);
    expect(body.results).toEqual([
      { email: 'pat@example.com', status: 'removed', role: 'writer', permissionId: 'p-pat' },
    ]);
    expect(body.permissions).toEqual([OWNER, LEE]);
    expectNothingButListAndDelete();
  });

  it.each([['owner'], ['organizer'], ['fileOrganizer']])(
    'T16: an address holding role %s is never removed',
    async (role) => {
      const entry = { id: 'p-x', type: 'user', role, emailAddress: 'boss@example.com' };
      api.permissions.list.mockResolvedValue(page([entry, LEE]));

      const { res, body } = await call({ file_id: 'file-1', recipients: ['boss@example.com'] });

      expect(res.isError).toBeUndefined();
      expect(api.permissions.delete).not.toHaveBeenCalled();
      expect(body.results[0].status).toBe('failed');
      expect(body.results[0].reason).toMatch(/never removes an owner or a manager/);
      expect(body.success).toBe(false);
    },
  );

  it('T17: anyone, domain and group entries are never removed, even a group carrying the named address', async () => {
    const anyone = { id: 'anyoneWithLink', type: 'anyone', role: 'reader' };
    const domain = { id: 'p-dom', type: 'domain', role: 'reader', domain: 'example.com' };
    const group = { id: 'p-grp', type: 'group', role: 'writer', emailAddress: 'team@example.com' };
    api.permissions.list.mockResolvedValue(page([OWNER, anyone, domain, group]));

    const { body } = await call({ file_id: 'file-1', recipients: ['team@example.com'] });

    expect(api.permissions.delete).not.toHaveBeenCalled();
    expect(body.results[0].status).toBe('not_found');
    expect(body.permissions).toEqual([OWNER, anyone, domain, group]);
  });

  it('T18: an address with no entry is not_found with the fixed note — not an error, but not success either', async () => {
    api.permissions.list.mockResolvedValue(page([OWNER, LEE]));

    const { res, body } = await call({ file_id: 'file-1', recipients: ['nobody@example.com'] });

    expect(res.isError).toBeUndefined();
    expect(api.permissions.delete).not.toHaveBeenCalled();
    expect(body.results[0].status).toBe('not_found');
    expect(body.results[0].reason).toMatch(/compare against "permissions"/);
    expect(body.success).toBe(false);
  });

  it('T19: case alone does not stop a match', async () => {
    api.permissions.list
      .mockResolvedValueOnce(page([OWNER, PAT]))
      .mockResolvedValueOnce(page([OWNER]));

    const { body } = await call({ file_id: 'file-1', recipients: ['Pat@Example.com'] });

    expect(api.permissions.delete).toHaveBeenCalledTimes(1);
    expect(api.permissions.delete.mock.calls[0][0].permissionId).toBe('p-pat');
    expect(body.results[0].status).toBe('removed');
  });

  it.each([
    ['a dotted local part', 'p.at@example.com', { id: 'p-1', type: 'user', role: 'reader', emailAddress: 'pat@example.com' }],
    ['a plus-tag', 'pat+docs@example.com', { id: 'p-1', type: 'user', role: 'reader', emailAddress: 'pat@example.com' }],
    ['the googlemail.com form of a gmail.com address', 'pat@googlemail.com', { id: 'p-1', type: 'user', role: 'reader', emailAddress: 'pat@gmail.com' }],
  ])('T19: a near miss (%s) is not_found and nothing is removed', async (_label, named, entry) => {
    api.permissions.list.mockResolvedValue(page([OWNER, entry]));

    const { body } = await call({ file_id: 'file-1', recipients: [named] });

    expect(api.permissions.delete).not.toHaveBeenCalled();
    expect(body.results[0].status).toBe('not_found');
  });
});

describe('unshare_drive_file — refusals before any Google call', () => {
  const refusals: Array<[string, Record<string, unknown>]> = [
    ['empty recipients', { file_id: 'file-1', recipients: [] }],
    ['an empty file id', { file_id: '  ', recipients: ['pat@example.com'] }],
    ['"*"', { file_id: 'file-1', recipients: ['*'] }],
    ['"all"', { file_id: 'file-1', recipients: ['all'] }],
    ['a bare domain', { file_id: 'file-1', recipients: ['example.com'] }],
    ['an address with no @', { file_id: 'file-1', recipients: ['pat.example.com'] }],
    ['a display name', { file_id: 'file-1', recipients: ['Pat <pat@example.com>'] }],
    ['two addresses in one string', { file_id: 'file-1', recipients: ['pat@example.com, lee@example.com'] }],
    ['a duplicate in different case', { file_id: 'file-1', recipients: ['pat@example.com', 'PAT@example.com'] }],
    ['an object item carrying a type', { file_id: 'file-1', recipients: [{ email: 'pat@example.com', type: 'anyone' }] }],
    ['an object item carrying a permission id', { file_id: 'file-1', recipients: [{ permission_id: 'p-pat' }] }],
  ];

  it.each(refusals)('T20: refuses %s with zero Drive calls', async (_label, args) => {
    const { res, text } = await call(args);

    expect(res.isError).toBe(true);
    expect(text).toMatch(/^Error: unshare_drive_file/);
    expect(api.permissions.list).not.toHaveBeenCalled();
    expect(api.permissions.delete).not.toHaveBeenCalled();
    expectNothingButListAndDelete();
  });
});

describe('unshare_drive_file — failures', () => {
  it('T21: the second of three deletes is refused (400) and still listed: removed, failed with Google\'s words, removed', async () => {
    api.permissions.list
      .mockResolvedValueOnce(page([OWNER, PAT, LEE, KIM]))
      .mockResolvedValueOnce(page([OWNER, LEE]));
    api.permissions.delete
      .mockResolvedValueOnce({ data: {} })
      .mockRejectedValueOnce(googleError(400, 'Bad Request: cannot remove this permission.', 'badRequest'))
      .mockResolvedValueOnce({ data: {} });

    const { res, body } = await call({
      file_id: 'file-1',
      recipients: ['pat@example.com', 'lee@example.com', 'kim@example.com'],
    });

    expect(res.isError).toBeUndefined();
    expect(api.permissions.delete).toHaveBeenCalledTimes(3);
    expect(api.permissions.list).toHaveBeenCalledTimes(2);
    expect(body.results.map((r: { status: string }) => r.status)).toEqual(['removed', 'failed', 'removed']);
    expect(body.results[1].reason).toContain('cannot remove this permission');
    expect(body.success).toBe(false);
  });

  it('T22: a missing scope on the first list names drive.file and the re-consent command; nothing is removed', async () => {
    api.permissions.list.mockRejectedValueOnce(
      googleError(403, 'Request had insufficient authentication scopes.', 'insufficientPermissions'),
    );

    const { res, text } = await call({ file_id: 'file-1', recipients: ['pat@example.com'] });

    expect(res.isError).toBe(true);
    expect(text).toContain('drive.file');
    expect(text).toContain('npm run auth -- work');
    expect(api.permissions.delete).not.toHaveBeenCalled();
  });

  it('T22: a 404 on the first list says the server reaches only files it created, with no re-auth advice; nothing is removed', async () => {
    api.permissions.list.mockRejectedValueOnce(googleError(404, 'File not found: file-1.', 'notFound'));

    const { res, text } = await call({ file_id: 'file-1', recipients: ['pat@example.com'] });

    expect(res.isError).toBe(true);
    expect(text).toMatch(/only files this server created itself/);
    expect(text).toContain('File not found: file-1.');
    expect(text).not.toMatch(/npm run auth|Re-authenticate with/);
    expect(api.permissions.delete).not.toHaveBeenCalled();
  });

  it('T23: a delete that succeeded but still shows in the read-back is unconfirmed, with the reason', async () => {
    api.permissions.list
      .mockResolvedValueOnce(page([OWNER, PAT]))
      .mockResolvedValueOnce(page([OWNER, PAT]));

    const { body } = await call({ file_id: 'file-1', recipients: ['pat@example.com'] });

    expect(body.results[0].status).toBe('unconfirmed');
    expect(body.results[0].reason).toMatch(/still shows/);
    expect(body.success).toBe(false);
  });

  it('T23: a delete that succeeded with a failed read-back is unconfirmed, and the list shown is the one taken before', async () => {
    api.permissions.list
      .mockResolvedValueOnce(page([OWNER, PAT]))
      .mockRejectedValueOnce(googleError(400, 'Bad Request'));

    const { res, body } = await call({ file_id: 'file-1', recipients: ['pat@example.com'] });

    expect(res.isError).toBeUndefined();
    expect(body.results[0].status).toBe('unconfirmed');
    expect(body.success).toBe(false);
    expect(body.readBackError).toContain('Bad Request');
    expect(body.permissionsTakenBeforeRemovals).toBe(true);
    expect(body.permissions).toEqual([OWNER, PAT]);
  });

  it('T24: a 404 on one delete with the id gone from the read-back is removed, and the next person is still processed', async () => {
    api.permissions.list
      .mockResolvedValueOnce(page([OWNER, PAT, LEE]))
      .mockResolvedValueOnce(page([OWNER]));
    api.permissions.delete
      .mockRejectedValueOnce(googleError(404, 'Permission not found: p-pat.', 'notFound'))
      .mockResolvedValueOnce({ data: {} });

    const { res, body } = await call({ file_id: 'file-1', recipients: ['pat@example.com', 'lee@example.com'] });

    expect(res.isError).toBeUndefined();
    expect(api.permissions.delete).toHaveBeenCalledTimes(2);
    expect(body.results.map((r: { status: string }) => r.status)).toEqual(['removed', 'removed']);
    expect(body.success).toBe(true);
  });

  it('T25: a person on the second page of the first list is found and removed; read-back pages are merged', async () => {
    api.permissions.list
      .mockResolvedValueOnce(page([OWNER, LEE], 'page-2'))
      .mockResolvedValueOnce(page([PAT]))
      .mockResolvedValueOnce(page([OWNER], 'page-2b'))
      .mockResolvedValueOnce(page([LEE]));

    const { body } = await call({ file_id: 'file-1', recipients: ['pat@example.com'] });

    expect(api.permissions.list).toHaveBeenCalledTimes(4);
    expect(api.permissions.list.mock.calls[1][0].pageToken).toBe('page-2');
    expect(api.permissions.list.mock.calls[3][0].pageToken).toBe('page-2b');
    expect(api.permissions.delete.mock.calls[0][0].permissionId).toBe('p-pat');
    expect(body.results[0].status).toBe('removed');
    expect(body.permissions).toEqual([OWNER, LEE]);
  });

  it('T26: an entry marked deleted, or with no address, is never matched', async () => {
    api.permissions.list.mockResolvedValue(page([
      OWNER,
      { id: 'p-gone', type: 'user', role: 'reader', emailAddress: 'pat@example.com', deleted: true },
      { id: 'p-blank', type: 'user', role: 'reader' },
    ]));

    const { body } = await call({ file_id: 'file-1', recipients: ['pat@example.com'] });

    expect(api.permissions.delete).not.toHaveBeenCalled();
    expect(body.results[0].status).toBe('not_found');
  });

  it('T26: two user entries with the same address fail that person and remove neither', async () => {
    api.permissions.list.mockResolvedValue(page([
      OWNER,
      { id: 'p-1', type: 'user', role: 'reader', emailAddress: 'pat@example.com' },
      { id: 'p-2', type: 'user', role: 'writer', emailAddress: 'PAT@example.com' },
    ]));

    const { body } = await call({ file_id: 'file-1', recipients: ['pat@example.com'] });

    expect(api.permissions.delete).not.toHaveBeenCalled();
    expect(body.results[0].status).toBe('failed');
    expect(body.results[0].reason).toMatch(/more than one/i);
  });
});

describe('unshare_drive_file — what it records and says', () => {
  it('T27: the log line holds no address; the token never reaches the output or the log', async () => {
    api.permissions.list
      .mockResolvedValueOnce(page([OWNER, PAT]))
      .mockResolvedValueOnce(page([OWNER]));

    const { text } = await call({ file_id: 'file-1', recipients: ['pat@example.com', 'nobody@example.com'] });

    const line = logCalls.find(l => l.message === 'unshare_drive_file');
    expect(line).toBeDefined();
    const logged = JSON.stringify(line!.fields);
    expect(logged).not.toContain('@');
    expect(logged).not.toContain('pat@example.com');
    expect(logged).not.toContain('nobody@example.com');
    expect(line!.fields).toMatchObject({ account: 'work', file_id: 'file-1' });
    expect(logged).toContain('p-pat');
    expect(logged).toContain('writer');

    expect(text).not.toContain(SENTINEL);
    expect(JSON.stringify(logCalls)).not.toContain(SENTINEL);
  });

  it('says in its description what it will and will not do', () => {
    const { name, description } = capture();
    expect(name).toBe('unshare_drive_file');
    expect(description).toMatch(/only on files this server created/i);
    expect(description).toMatch(/never the owner, a group, a domain or link sharing/i);
    expect(description).toMatch(/whoever granted it/i);
    expect(description).toMatch(/no notification/i);
    expect(description).toMatch(/share_drive_file/);
  });
});
