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
  CONVERTIBLE_EXTENSIONS,
  CONVERT_TARGET_BY_SOURCE_MIME,
  DRIVE_FILE_SCOPE,
  GOOGLE_DOC_MIME,
  GOOGLE_SHEET_MIME,
  GOOGLE_SLIDES_MIME,
  MAX_DRIVE_UPLOAD_BYTES,
  convertTargetForFilename,
  driveFileName,
  getDriveClient,
  uploadFile,
} = await import('./client.js');

const { mimeTypeForFilename } = await import('../gmail/mime.js');

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

// ---------------------------------------------------------------------------
// CV — convert-on-upload.
//
// An uploaded .xlsx used to land in Drive as a stored Office file: clicking it
// opens a preview, not a spreadsheet you can edit. The mechanism that fixes it
// already existed in this repo for `create_google_doc` — naming the TARGET
// google-apps mimeType on a `files.create` makes Drive convert the media rather
// than store it — and these pin that mechanism generalised to uploads, plus the
// two things that must NOT change: the default path, and the refusal for a
// source type Google cannot convert.
// ---------------------------------------------------------------------------

describe('the conversion map', () => {
  it('names the three Google types by their real mimeTypes', () => {
    // Pinned as literals on purpose: every behavioural assertion below compares
    // against these strings, and two undefined constants would agree with each
    // other perfectly while proving nothing.
    expect(GOOGLE_SHEET_MIME).toBe('application/vnd.google-apps.spreadsheet');
    expect(GOOGLE_DOC_MIME).toBe('application/vnd.google-apps.document');
    expect(GOOGLE_SLIDES_MIME).toBe('application/vnd.google-apps.presentation');
  });

  it('maps every spreadsheet source Google accepts, and only to a Google Sheet', () => {
    for (const source of [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // xlsx
      'application/vnd.ms-excel', // xls
      'application/vnd.oasis.opendocument.spreadsheet', // ods
      'text/csv',
      'text/tab-separated-values',
    ]) {
      expect(CONVERT_TARGET_BY_SOURCE_MIME[source]).toBe(GOOGLE_SHEET_MIME);
    }
  });

  it('maps the document sources to a Google Doc', () => {
    for (const source of [
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // docx
      'application/msword', // doc
      'application/vnd.oasis.opendocument.text', // odt
      'application/rtf',
      'text/plain',
    ]) {
      expect(CONVERT_TARGET_BY_SOURCE_MIME[source]).toBe(GOOGLE_DOC_MIME);
    }
  });

  it('maps the presentation sources to Google Slides', () => {
    for (const source of [
      'application/vnd.openxmlformats-officedocument.presentationml.presentation', // pptx
      'application/vnd.ms-powerpoint', // ppt
      'application/vnd.oasis.opendocument.presentation', // odp
    ]) {
      expect(CONVERT_TARGET_BY_SOURCE_MIME[source]).toBe(GOOGLE_SLIDES_MIME);
    }
  });

  it('invents nothing beyond those thirteen — every entry is one Google can import', () => {
    // The live harness (H-A0) checks this map against Google's own
    // about.get(importFormats). Keeping the map closed is what makes that
    // check meaningful: a guessed entry would fail live rather than here.
    expect(Object.keys(CONVERT_TARGET_BY_SOURCE_MIME).sort()).toEqual([
      'application/msword',
      'application/rtf',
      'application/vnd.ms-excel',
      'application/vnd.ms-powerpoint',
      'application/vnd.oasis.opendocument.presentation',
      'application/vnd.oasis.opendocument.spreadsheet',
      'application/vnd.oasis.opendocument.text',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/csv',
      'text/plain',
      'text/tab-separated-values',
    ]);
  });

  it('does not offer to convert a PDF or an image — Drive stores those as they are', () => {
    expect(CONVERT_TARGET_BY_SOURCE_MIME['application/pdf']).toBeUndefined();
    expect(CONVERT_TARGET_BY_SOURCE_MIME['image/png']).toBeUndefined();
  });

  it('every extension the refusal advertises really does resolve into the map', () => {
    // The refusal names extensions, because that is what a caller has. This is
    // the join between the two vocabularies: an extension in the message that
    // mimeTypeForFilename cannot type would be advice that does not work.
    for (const ext of CONVERTIBLE_EXTENSIONS) {
      const mime = mimeTypeForFilename(`sample.${ext}`);
      expect(mime, `mimeTypeForFilename could not type .${ext}`).not.toBe('application/octet-stream');
      expect(CONVERT_TARGET_BY_SOURCE_MIME[mime], `.${ext} → ${mime} is not in the map`).toBeDefined();
    }
  });

  it('advertises all thirteen extensions, so nothing supported is hidden from the caller', () => {
    expect([...CONVERTIBLE_EXTENSIONS].sort()).toEqual(
      ['csv', 'doc', 'docx', 'odp', 'ods', 'odt', 'ppt', 'pptx', 'rtf', 'tsv', 'txt', 'xls', 'xlsx'],
    );
  });
});

describe('convertTargetForFilename', () => {
  it('answers with the Google type an upload of that name would become', () => {
    expect(convertTargetForFilename('budget.xlsx')).toBe('application/vnd.google-apps.spreadsheet');
    expect(convertTargetForFilename('notes.TXT')).toBe('application/vnd.google-apps.document');
    expect(convertTargetForFilename('deck.pptx')).toBe('application/vnd.google-apps.presentation');
  });

  it('answers undefined for anything Google will not convert', () => {
    expect(convertTargetForFilename('scan.pdf')).toBeUndefined();
    expect(convertTargetForFilename('archive.zip')).toBeUndefined();
    expect(convertTargetForFilename('noextension')).toBeUndefined();
  });
});

describe('uploadFile with convert', () => {
  function convertedResponse(over: Record<string, unknown> = {}) {
    // A converted Google file: no `size` at all — Drive does not report a byte
    // size for its own formats. `okResponse` carries one, so this shape is the
    // one the result-building code has to survive.
    return {
      data: {
        id: 'sheet-1',
        name: 'fixture.csv',
        mimeType: 'application/vnd.google-apps.spreadsheet',
        webViewLink: 'https://docs.google.com/spreadsheets/d/sheet-1/edit',
        ...over,
      },
    };
  }

  it('names the TARGET google type on the metadata and keeps the real type on the media', async () => {
    api.files.create.mockResolvedValueOnce(convertedResponse());
    const filePath = tempFile('fixture.csv', 'a,b\n1,2\n');

    await uploadFile({ filePath, convert: true, account: 'work' });

    const args = api.files.create.mock.calls[0][0];
    // The whole mechanism, in two lines: metadata says what it should BECOME,
    // media says what the bytes actually ARE.
    expect(args.requestBody.mimeType).toBe('application/vnd.google-apps.spreadsheet');
    expect(args.media.mimeType).toBe('text/csv');
  });

  it('reports the type Google actually returned, and says the file was converted', async () => {
    api.files.create.mockResolvedValueOnce(convertedResponse());
    const filePath = tempFile('fixture.csv', 'a,b\n1,2\n');

    const result = await uploadFile({ filePath, convert: true });

    expect(result.converted).toBe(true);
    expect(result.mimeType).toBe('application/vnd.google-apps.spreadsheet');
    expect(result.webViewLink).toBe('https://docs.google.com/spreadsheets/d/sheet-1/edit');
  });

  it('does not pass off the local byte count as the Drive size when Google reports none', async () => {
    api.files.create.mockResolvedValueOnce(convertedResponse());
    const filePath = tempFile('fixture.csv', 'a,b\n1,2\n');

    const result = await uploadFile({ filePath, convert: true });

    expect(result.driveSize).toBeUndefined();
    expect(result.size).toBe('a,b\n1,2\n'.length); // the local stat, named as such
  });

  it('converts a .txt into a Google Doc', async () => {
    api.files.create.mockResolvedValueOnce(convertedResponse({
      id: 'doc-1', name: 'fixture.txt', mimeType: 'application/vnd.google-apps.document',
    }));
    const filePath = tempFile('fixture.txt', 'hello');

    const result = await uploadFile({ filePath, convert: true });

    expect(api.files.create.mock.calls[0][0].requestBody.mimeType).toBe('application/vnd.google-apps.document');
    expect(api.files.create.mock.calls[0][0].media.mimeType).toBe('text/plain');
    expect(result.mimeType).toBe('application/vnd.google-apps.document');
  });

  it('decides from the NAME the file will have in Drive, not just the local one', async () => {
    api.files.create.mockResolvedValueOnce(convertedResponse());
    const filePath = tempFile('blob');

    await uploadFile({ filePath, name: 'data.csv', convert: true });

    expect(api.files.create.mock.calls[0][0].requestBody.mimeType)
      .toBe('application/vnd.google-apps.spreadsheet');
  });

  it('still parents into a folder when one is given', async () => {
    api.files.create.mockResolvedValueOnce(convertedResponse());
    const filePath = tempFile('fixture.csv', 'a,b\n');

    await uploadFile({ filePath, folderId: 'folder-9', convert: true });

    const body = api.files.create.mock.calls[0][0].requestBody;
    expect(body.parents).toEqual(['folder-9']);
    expect(body.mimeType).toBe('application/vnd.google-apps.spreadsheet');
  });

  it('records the conversion in the log, still without the local path', async () => {
    api.files.create.mockResolvedValueOnce(convertedResponse());
    const filePath = tempFile('fixture.csv', 'a,b\n');

    await uploadFile({ filePath, convert: true, account: 'work' });

    const entry = logCalls.find(c => c.message === 'upload_drive_file');
    expect(entry?.fields.convert_to).toBe('application/vnd.google-apps.spreadsheet');
    expect(JSON.stringify(entry?.fields)).not.toContain(filePath);
  });
});

describe('uploadFile refuses a conversion Google cannot do', () => {
  it('refuses a PDF before any network call, and names what it can convert', async () => {
    const filePath = tempFile('scan.pdf', 'not really a pdf');

    await expect(uploadFile({ filePath, convert: true })).rejects.toThrow(
      /cannot be converted/i,
    );
    // The caller has an extension in their hand, so the cure is stated in
    // extensions — and the refusal costs nothing, because it happens here.
    await expect(uploadFile({ filePath, convert: true })).rejects.toThrow(/xlsx/);
    await expect(uploadFile({ filePath, convert: true })).rejects.toThrow(/docx/);
    expect(api.files.create).not.toHaveBeenCalled();
  });

  it('refuses a file with no extension at all rather than uploading it unconverted', async () => {
    const filePath = tempFile('blob');

    await expect(uploadFile({ filePath, convert: true })).rejects.toThrow(/cannot be converted/i);
    expect(api.files.create).not.toHaveBeenCalled();
  });

  it('says which type it was asked to convert, so the message is diagnosable', async () => {
    const filePath = tempFile('scan.pdf');

    await expect(uploadFile({ filePath, convert: true })).rejects.toThrow(/application\/pdf/);
  });

  it('uploads that same PDF happily when convert is not asked for', async () => {
    api.files.create.mockResolvedValueOnce(okResponse());
    const filePath = tempFile('scan.pdf');

    const result = await uploadFile({ filePath });

    expect(result.id).toBe('file-123');
    expect(api.files.create).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// The default path, pinned. `convert` is an opt-in: a call that does not pass
// it must produce byte-for-byte the request v1.9.0 produced, because every
// existing caller is making exactly that call.
// ---------------------------------------------------------------------------

describe('the default upload path is untouched by the convert option', () => {
  it('sends NO mimeType in the metadata when convert is unset', async () => {
    api.files.create.mockResolvedValueOnce(okResponse());
    const filePath = tempFile('summary.pdf');

    await uploadFile({ filePath });

    const body = api.files.create.mock.calls[0][0].requestBody;
    expect('mimeType' in body).toBe(false);
    expect(Object.keys(body)).toEqual(['name']);
  });

  it('sends NO mimeType in the metadata when convert is explicitly false', async () => {
    api.files.create.mockResolvedValueOnce(okResponse({ mimeType: 'text/csv', name: 'fixture.csv' }));
    const filePath = tempFile('fixture.csv', 'a,b\n');

    const result = await uploadFile({ filePath, convert: false });

    const body = api.files.create.mock.calls[0][0].requestBody;
    expect('mimeType' in body).toBe(false);
    expect(result.mimeType).toBe('text/csv');
  });

  it('keeps the whole request shape it had in v1.9.0', async () => {
    api.files.create.mockResolvedValueOnce(okResponse());
    const filePath = tempFile('summary.pdf');

    await uploadFile({ filePath, folderId: 'folder-9' });

    const args = api.files.create.mock.calls[0][0];
    expect(Object.keys(args).sort()).toEqual(['fields', 'media', 'requestBody', 'supportsAllDrives']);
    expect(args.requestBody).toEqual({ name: 'summary.pdf', parents: ['folder-9'] });
    expect(args.media.mimeType).toBe('application/pdf');
    expect(args.fields).toBe('id,name,mimeType,size,webViewLink,webContentLink,parents');
    expect(args.supportsAllDrives).toBe(true);
  });

  it('reports no `converted` flag at all when nothing was converted', async () => {
    api.files.create.mockResolvedValueOnce(okResponse());
    const filePath = tempFile('summary.pdf');

    const result = await uploadFile({ filePath });

    expect(result.converted).toBeUndefined();
    expect('converted' in result).toBe(false);
  });

  it('logs convert_to as null when no conversion was asked for', async () => {
    api.files.create.mockResolvedValueOnce(okResponse());
    const filePath = tempFile('summary.pdf');

    await uploadFile({ filePath });

    const entry = logCalls.find(c => c.message === 'upload_drive_file');
    expect(entry?.fields.convert_to).toBeNull();
  });
});
