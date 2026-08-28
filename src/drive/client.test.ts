/**
 * Tests for the Drive client layer — exercised against a stubbed `drive_v3`.
 * `googleapis`, the OAuth client, the account config and the logger are all
 * mocked, so nothing here touches the network, the token files or the real
 * accounts.json. No file is ever uploaded to a real Drive.
 *
 * These tests are the ONLY coverage this code can have right now: no stored
 * token carries the `drive.file` scope until every alias re-consents, so a live
 * probe of `files.create` could not succeed even if a builder were allowed to
 * make one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const api = {
  files: { create: vi.fn(), get: vi.fn(), list: vi.fn(), export: vi.fn() },
};

vi.mock('googleapis', () => ({
  google: { drive: () => api },
}));

vi.mock('../gmail/auth.js', () => ({
  getAuthClient: vi.fn(async () => ({})),
}));

vi.mock('../config.js', () => ({
  resolveAccount: (input?: string) => ({
    alias: input ?? 'test',
    email: input?.includes('@') ? input : 'me@example.com',
  }),
}));

const logCalls: { level: string; message: string; fields: Record<string, unknown> }[] = [];
vi.mock('../log.js', () => ({
  log: (level: string, message: string, fields: Record<string, unknown> = {}) => {
    logCalls.push({ level, message, fields });
  },
}));

const {
  DRIVE_FILE_SCOPE,
  MAX_DRIVE_UPLOAD_BYTES,
  driveFileName,
  getDriveClient,
  uploadFile,
} = await import('./client.js');

/** Write a temp file and return its absolute path. */
function tempFile(name: string, contents = 'hello drive'): string {
  const dir = mkdtempSync(join(tmpdir(), 'drive-upload-'));
  const filePath = join(dir, name);
  writeFileSync(filePath, contents);
  return filePath;
}

function okResponse(over: Record<string, unknown> = {}) {
  return {
    data: {
      id: 'file-123',
      name: 'summary.pdf',
      mimeType: 'application/pdf',
      size: '11',
      webViewLink: 'https://drive.google.com/file/d/file-123/view',
      ...over,
    },
  };
}

beforeEach(() => {
  for (const fn of Object.values(api.files)) (fn as ReturnType<typeof vi.fn>).mockReset();
  logCalls.length = 0;
});

// ---------------------------------------------------------------------------
// client factory (unchanged behaviour, pinned)
// ---------------------------------------------------------------------------

describe('getDriveClient', () => {
  it('returns the same cached client for repeat calls on one account', async () => {
    const a = await getDriveClient('cache-probe@example.com');
    const b = await getDriveClient('cache-probe@example.com');
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// driveFileName
// ---------------------------------------------------------------------------

describe('driveFileName', () => {
  it('defaults to the local basename', () => {
    expect(driveFileName(undefined, '/tmp/dir/report.pdf')).toBe('report.pdf');
  });

  it('uses an override when one is given', () => {
    expect(driveFileName('Q3 Summary.pdf', '/tmp/dir/report.pdf')).toBe('Q3 Summary.pdf');
  });

  it('will not let an override smuggle a directory', () => {
    expect(driveFileName('../../etc/passwd', '/tmp/dir/report.pdf')).toBe('passwd');
  });

  it('strips control characters from an override', () => {
    expect(driveFileName('re\r\np\u0000ort.pdf', '/tmp/dir/x.pdf')).toBe('report.pdf');
  });

  it('falls back to the local basename when the override cleans to nothing', () => {
    expect(driveFileName('   ', '/tmp/dir/report.pdf')).toBe('report.pdf');
    expect(driveFileName('\u0000\u0001', '/tmp/dir/report.pdf')).toBe('report.pdf');
  });
});

// ---------------------------------------------------------------------------
// uploadFile — refusals happen BEFORE any API call
// ---------------------------------------------------------------------------

describe('uploadFile refusals', () => {
  it('refuses a relative path and never calls the API', async () => {
    await expect(uploadFile({ filePath: 'reports/summary.pdf' }))
      .rejects.toThrow(/must be absolute/);
    expect(api.files.create).not.toHaveBeenCalled();
  });

  it('refuses an empty path', async () => {
    await expect(uploadFile({ filePath: '   ' })).rejects.toThrow(/path is required/);
    expect(api.files.create).not.toHaveBeenCalled();
  });

  it('refuses a path that does not exist', async () => {
    await expect(uploadFile({ filePath: '/nonexistent/definitely/not/here.pdf' }))
      .rejects.toThrow(/file not found/);
    expect(api.files.create).not.toHaveBeenCalled();
  });

  it('refuses a directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'drive-upload-dir-'));
    await expect(uploadFile({ filePath: dir })).rejects.toThrow(/not a regular file/);
    expect(api.files.create).not.toHaveBeenCalled();
  });

  it('refuses a file over the 100MB ceiling, by stat, before reading it', async () => {
    // A sparse file: the stat reports 100,000,001 bytes without any of them
    // being written, so the ceiling is exercised against the real fs rather
    // than against a mocked stat.
    const { openSync, ftruncateSync, closeSync, unlinkSync } = await import('fs');
    const filePath = tempFile('big.bin', '');
    const fd = openSync(filePath, 'r+');
    ftruncateSync(fd, MAX_DRIVE_UPLOAD_BYTES + 1);
    closeSync(fd);

    await expect(uploadFile({ filePath }))
      .rejects.toThrow(/big\.bin is 100\.0MB; the per-file limit is 100MB/);
    expect(api.files.create).not.toHaveBeenCalled();
    unlinkSync(filePath);
  });
});

// ---------------------------------------------------------------------------
// uploadFile — the happy path
// ---------------------------------------------------------------------------

describe('uploadFile', () => {
  it('uploads with the local basename and returns id, link and size', async () => {
    api.files.create.mockResolvedValueOnce(okResponse());
    const filePath = tempFile('summary.pdf');

    const result = await uploadFile({ filePath, account: 'work' });

    const args = api.files.create.mock.calls[0][0];
    expect(args.requestBody.name).toBe('summary.pdf');
    expect(args.requestBody.parents).toBeUndefined();
    expect(args.media.mimeType).toBe('application/pdf');
    expect(args.fields).toContain('webViewLink');

    expect(result.id).toBe('file-123');
    expect(result.webViewLink).toBe('https://drive.google.com/file/d/file-123/view');
    expect(result.size).toBe('hello drive'.length);
    expect(result.driveSize).toBe(11);
    expect(result.account).toBe('work');
  });

  it('passes a folder id as the parent and echoes it back', async () => {
    api.files.create.mockResolvedValueOnce(okResponse());
    const filePath = tempFile('summary.pdf');

    const result = await uploadFile({ filePath, folderId: 'folder-9' });

    expect(api.files.create.mock.calls[0][0].requestBody.parents).toEqual(['folder-9']);
    expect(result.folderId).toBe('folder-9');
  });

  it('honours a name override and derives the content type from it', async () => {
    api.files.create.mockResolvedValueOnce(okResponse({ name: 'notes.txt', mimeType: 'text/plain' }));
    const filePath = tempFile('blob');

    const result = await uploadFile({ filePath, name: 'notes.txt' });

    const args = api.files.create.mock.calls[0][0];
    expect(args.requestBody.name).toBe('notes.txt');
    expect(args.media.mimeType).toBe('text/plain');
    expect(result.name).toBe('notes.txt');
  });

  it('falls back to the local extension when the override has none', async () => {
    api.files.create.mockResolvedValueOnce(okResponse());
    const filePath = tempFile('summary.pdf');

    await uploadFile({ filePath, name: 'Q3 Summary' });

    expect(api.files.create.mock.calls[0][0].media.mimeType).toBe('application/pdf');
  });

  it('sends a readable stream as the body, not a buffered string', async () => {
    api.files.create.mockResolvedValueOnce(okResponse());
    const filePath = tempFile('summary.pdf');

    await uploadFile({ filePath });

    const body = api.files.create.mock.calls[0][0].media.body;
    expect(typeof body.pipe).toBe('function');
  });

  it('logs the upload with ids and sizes only — never the local path', async () => {
    api.files.create.mockResolvedValueOnce(okResponse());
    const filePath = tempFile('summary.pdf');

    await uploadFile({ filePath, folderId: 'folder-9', account: 'work' });

    const entry = logCalls.find(c => c.message === 'upload_drive_file');
    expect(entry).toBeDefined();
    expect(entry?.fields).toMatchObject({
      account: 'work',
      file_id: 'file-123',
      folder_id: 'folder-9',
      bytes: 'hello drive'.length,
    });
    expect(JSON.stringify(entry?.fields)).not.toContain(filePath);
  });

  it('creates a FRESH stream per attempt, so a retried upload re-reads the file', async () => {
    api.files.create
      .mockRejectedValueOnce(Object.assign(new Error('backend error'), { code: 503 }))
      .mockResolvedValueOnce(okResponse());
    const filePath = tempFile('summary.pdf');

    const result = await uploadFile({ filePath });

    expect(api.files.create).toHaveBeenCalledTimes(2);
    const first = api.files.create.mock.calls[0][0].media.body;
    const second = api.files.create.mock.calls[1][0].media.body;
    expect(first).not.toBe(second);
    expect(result.id).toBe('file-123');
  }, 15_000);
});

// ---------------------------------------------------------------------------
// The missing-scope path — the state EVERY account is in until it re-consents
// ---------------------------------------------------------------------------

describe('uploadFile without the drive.file grant', () => {
  it('turns a 403 into a re-consent instruction naming the scope and the alias', async () => {
    api.files.create.mockRejectedValue(
      Object.assign(new Error('Request had insufficient authentication scopes.'), { code: 403 }),
    );
    const filePath = tempFile('summary.pdf');

    await expect(uploadFile({ filePath, account: 'steve-ah' })).rejects.toThrow(
      /upload_drive_file needs the .*drive\.file scope/,
    );
    await expect(uploadFile({ filePath, account: 'steve-ah' })).rejects.toThrow(
      /npm run auth -- steve-ah/,
    );
  });

  it('names the exact scope constant', async () => {
    api.files.create.mockRejectedValue(
      Object.assign(new Error('insufficient scopes'), { code: 403 }),
    );
    const filePath = tempFile('summary.pdf');

    await expect(uploadFile({ filePath })).rejects.toThrow(DRIVE_FILE_SCOPE);
  });

  it('leaves a non-auth failure alone', async () => {
    api.files.create.mockRejectedValue(
      Object.assign(new Error('File not found: folder-9'), { code: 404 }),
    );
    const filePath = tempFile('summary.pdf');

    await expect(uploadFile({ filePath, folderId: 'folder-9' }))
      .rejects.toThrow(/File not found: folder-9/);
  });
});

// ---------------------------------------------------------------------------
// P3 — upload_drive_file was the last Drive/Docs tool on withScopeHint +
// withRetry rather than the shared googleApiCall honesty path. withScopeHint
// only rescues a MISSING SCOPE; every other 403 fell through to withRetry's
// rewrite, "Authentication error (403) … Re-authenticate with: npx tsx
// src/auth.ts". Drive's other 403s — a folder the account cannot write to, a
// project with the Drive API switched off, a storage quota — are none of them
// a broken login, and re-authenticating fixes none of them.
// ---------------------------------------------------------------------------

describe('upload_drive_file tells the truth about a 403 that is not a missing scope', () => {
  /** A Google API error in the shape googleapis actually throws. */
  function googleError(status: number, reason: string, message: string): Error {
    return Object.assign(new Error(message), {
      code: status,
      errors: [{ reason }],
      response: { status, data: { error: { errors: [{ reason }] } } },
    });
  }

  it('a per-folder permission refusal keeps Google\'s words and drops the re-auth advice', async () => {
    api.files.create.mockRejectedValue(
      googleError(403, 'insufficientFilePermissions', 'The user does not have sufficient permissions for this file.'),
    );
    const filePath = tempFile('summary.pdf');

    await expect(uploadFile({ filePath, folderId: 'folder-9', account: 'work' })).rejects.toThrow(
      /The user does not have sufficient permissions for this file\./,
    );
    await expect(uploadFile({ filePath, folderId: 'folder-9', account: 'work' })).rejects.not.toThrow(
      /Re-authenticate with: npx tsx/,
    );
  });

  it('a disabled Drive API says to enable it in the console, and that a re-login will not help', async () => {
    api.files.create.mockRejectedValue(googleError(
      403,
      'accessNotConfigured',
      'Google Drive API has not been used in project 12345 before or it is disabled.',
    ));
    const filePath = tempFile('summary.pdf');

    await expect(uploadFile({ filePath, account: 'work' })).rejects.toThrow(
      /Google Drive API is not enabled/,
    );
    await expect(uploadFile({ filePath, account: 'work' })).rejects.toThrow(/will not help/);
  });

  it('still retries a 5xx with a fresh stream — moving onto the honest path kept the retry', async () => {
    api.files.create
      .mockRejectedValueOnce(Object.assign(new Error('backend error'), { code: 503 }))
      .mockResolvedValueOnce(okResponse());
    const filePath = tempFile('summary.pdf');

    const result = await uploadFile({ filePath });

    expect(api.files.create).toHaveBeenCalledTimes(2);
    const first = api.files.create.mock.calls[0][0].media.body;
    const second = api.files.create.mock.calls[1][0].media.body;
    expect(first).not.toBe(second);
    expect(result.id).toBe('file-123');
  }, 15_000);

  it('a 401 is still left to the shared re-authenticate path, where re-login IS the fix', async () => {
    api.files.create.mockRejectedValue(googleError(401, 'authError', 'Invalid Credentials'));
    const filePath = tempFile('summary.pdf');

    await expect(uploadFile({ filePath })).rejects.toThrow(/Authentication error \(401\)/);
  });
});
