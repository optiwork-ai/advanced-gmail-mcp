/**
 * Tests for the Gmail API layer in client.ts — the functions that actually talk
 * to Google, exercised against a stubbed `gmail_v1.Gmail`.
 *
 * `googleapis`, `./auth.js` and `../config.js` are all mocked, so nothing here
 * touches the network, the OAuth token files, or the real accounts.json.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// --- stub the Gmail API surface -------------------------------------------

const api = {
  getProfile: vi.fn(),
  history: { list: vi.fn() },
  messages: {
    get: vi.fn(),
    list: vi.fn(),
    modify: vi.fn(),
    trash: vi.fn(),
    send: vi.fn(),
    batchModify: vi.fn(),
    attachments: { get: vi.fn() },
  },
  threads: { get: vi.fn(), modify: vi.fn(), trash: vi.fn() },
  drafts: {
    list: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    send: vi.fn(),
  },
  labels: { list: vi.fn(), get: vi.fn(), create: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  settings: { sendAs: { list: vi.fn() } },
};

const gmailStub = { users: api };

vi.mock('googleapis', () => ({
  google: { gmail: () => gmailStub },
}));

vi.mock('./auth.js', () => ({
  getAuthClient: vi.fn(async () => ({})),
}));

// G12: the on-disk cursor store is stubbed so these tests never write to the
// real cursors/ directory, and so the store's own contract can be simulated.
type CursorWrite = { stored: boolean; reason?: string };
const cursorStore = {
  readCursor: vi.fn((_alias: string): string | null => null),
  writeCursor: vi.fn((_alias: string, _id: string): CursorWrite => ({ stored: true })),
};
vi.mock('./cursor-store.js', () => ({
  readCursor: (alias: string) => cursorStore.readCursor(alias),
  writeCursor: (alias: string, id: string) => cursorStore.writeCursor(alias, id),
}));

vi.mock('../config.js', () => ({
  resolveAccount: (input?: string) => ({
    alias: input ?? 'test',
    email: input?.includes('@') ? input : 'me@example.com',
  }),
}));

const {
  ATTACHMENT_INLINE_LIMIT_BYTES,
  DEFAULT_LIST_PAGE_SIZE,
  MAX_LIST_PAGE_SIZE,
  MAX_HISTORY_PAGE_SIZE,
  DEFAULT_HISTORY_PAGE_SIZE,
  HISTORY_SUMMARY_CAP,
  BATCH_MODIFY_CHUNK,
  batchModify,
  batchTrash,
  createLabel,
  deleteDraft,
  deleteLabel,
  getAttachment,
  getHistoryBaseline,
  getMailChanges,
  getMessage,
  getThread,
  createDraft,
  forwardMessage,
  replyToMessage,
  sendMessage,
  listDrafts,
  listLabels,
  listMessages,
  modifyMessage,
  modifyThread,
  readDraft,
  safeAttachmentFilename,
  searchMessages,
  trashMessage,
  trashThread,
  unsubscribeFromEmail,
  updateDraft,
  updateLabel,
  withRetry,
} = await import('./client.js');

function ok<T>(data: T) {
  return { data };
}

function b64url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url');
}

beforeEach(() => {
  vi.clearAllMocks();
  api.settings.sendAs.list.mockResolvedValue(ok({ sendAs: [] }));
});

// ---------------------------------------------------------------------------
// safeAttachmentFilename
// ---------------------------------------------------------------------------

describe('safeAttachmentFilename', () => {
  it('passes an ordinary filename through', () => {
    expect(safeAttachmentFilename('invoice.pdf')).toBe('invoice.pdf');
  });

  it('strips a POSIX directory traversal', () => {
    expect(safeAttachmentFilename('../../.ssh/authorized_keys')).toBe('authorized_keys');
  });

  it('strips a Windows-style traversal', () => {
    expect(safeAttachmentFilename('..\\..\\windows\\system32\\evil.dll')).toBe('evil.dll');
  });

  it('refuses an absolute path', () => {
    expect(safeAttachmentFilename('/etc/passwd')).toBe('passwd');
  });

  it('rejects a bare dot-run', () => {
    expect(safeAttachmentFilename('..')).toBe('attachment');
    expect(safeAttachmentFilename('.')).toBe('attachment');
  });

  it('strips CR/LF, quotes and NULs', () => {
    expect(safeAttachmentFilename('a\r\nb"c\0.txt')).toBe('abc.txt');
  });

  it('falls back to "attachment" for an empty name', () => {
    expect(safeAttachmentFilename('')).toBe('attachment');
    expect(safeAttachmentFilename('   ')).toBe('attachment');
  });

  it('caps a pathological length', () => {
    expect(safeAttachmentFilename('x'.repeat(500))).toHaveLength(200);
  });
});

// ---------------------------------------------------------------------------
// get_attachment
// ---------------------------------------------------------------------------

describe('getAttachment', () => {
  function messageWithAttachment(size: number, filename = 'report.pdf') {
    return ok({
      id: 'm1',
      payload: {
        mimeType: 'multipart/mixed',
        parts: [
          { mimeType: 'text/plain', body: { data: b64url('body') } },
          {
            mimeType: 'application/pdf',
            filename,
            body: { attachmentId: 'att1', size },
          },
        ],
      },
    });
  }

  it('returns filename, mimeType and padded standard base64 for a small attachment', async () => {
    api.messages.get.mockResolvedValue(messageWithAttachment(5));
    // 5 bytes encodes to base64 needing '=' padding — the old code dropped it.
    api.messages.attachments.get.mockResolvedValue(
      ok({ size: 5, data: Buffer.from('hello').toString('base64url') }),
    );

    const result = await getAttachment({ messageId: 'm1', attachmentId: 'att1' });

    expect(result).toEqual({
      attachmentId: 'att1',
      filename: 'report.pdf',
      mimeType: 'application/pdf',
      size: 5,
      data_base64: 'aGVsbG8=',
    });
    expect(result.data_base64!.endsWith('=')).toBe(true);
    expect(Buffer.from(result.data_base64!, 'base64').toString()).toBe('hello');
  });

  it('decodes base64url payloads containing - and _ correctly', async () => {
    const bytes = Buffer.from([0xfb, 0xef, 0xbe]); // encodes to "++++"-class chars
    api.messages.get.mockResolvedValue(messageWithAttachment(bytes.length, 'x.bin'));
    api.messages.attachments.get.mockResolvedValue(
      ok({ size: bytes.length, data: bytes.toString('base64url') }),
    );

    const result = await getAttachment({ messageId: 'm1', attachmentId: 'att1' });
    expect(Buffer.from(result.data_base64!, 'base64').equals(bytes)).toBe(true);
  });

  it('refuses to inline an attachment over the limit, and names save_dir', async () => {
    api.messages.get.mockResolvedValue(messageWithAttachment(ATTACHMENT_INLINE_LIMIT_BYTES + 1));

    await expect(getAttachment({ messageId: 'm1', attachmentId: 'att1' })).rejects.toThrow(
      /save_dir/,
    );
    // and it does NOT download the bytes it is about to refuse
    expect(api.messages.attachments.get).not.toHaveBeenCalled();
  });

  it('writes to save_dir and returns the path instead of base64', async () => {
    const { mkdtempSync, readFileSync } = await import('fs');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const dir = mkdtempSync(join(tmpdir(), 'gmail-att-'));

    api.messages.get.mockResolvedValue(messageWithAttachment(5));
    api.messages.attachments.get.mockResolvedValue(
      ok({ size: 5, data: Buffer.from('hello').toString('base64url') }),
    );

    const result = await getAttachment({ messageId: 'm1', attachmentId: 'att1', saveDir: dir });

    expect(result.path).toBe(join(dir, 'report.pdf'));
    expect(result.data_base64).toBeUndefined();
    expect(result.filename).toBe('report.pdf');
    expect(result.mimeType).toBe('application/pdf');
    expect(readFileSync(result.path!, 'utf8')).toBe('hello');
  });

  it('never overwrites: a collision gets a -1 suffix before the extension', async () => {
    const { mkdtempSync, writeFileSync } = await import('fs');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const dir = mkdtempSync(join(tmpdir(), 'gmail-att-'));
    writeFileSync(join(dir, 'report.pdf'), 'pre-existing');

    api.messages.get.mockResolvedValue(messageWithAttachment(5));
    api.messages.attachments.get.mockResolvedValue(
      ok({ size: 5, data: Buffer.from('hello').toString('base64url') }),
    );

    const result = await getAttachment({ messageId: 'm1', attachmentId: 'att1', saveDir: dir });
    expect(result.path).toBe(join(dir, 'report-1.pdf'));
  });

  it('writes an oversized attachment to disk without complaint', async () => {
    const { mkdtempSync } = await import('fs');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const dir = mkdtempSync(join(tmpdir(), 'gmail-att-'));

    api.messages.get.mockResolvedValue(
      messageWithAttachment(ATTACHMENT_INLINE_LIMIT_BYTES + 1, 'big.bin'),
    );
    api.messages.attachments.get.mockResolvedValue(
      ok({ data: Buffer.alloc(1024).toString('base64url') }),
    );

    const result = await getAttachment({ messageId: 'm1', attachmentId: 'att1', saveDir: dir });
    expect(result.path).toBe(join(dir, 'big.bin'));
  });

  it('sanitizes a traversal filename before writing', async () => {
    const { mkdtempSync, existsSync } = await import('fs');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const dir = mkdtempSync(join(tmpdir(), 'gmail-att-'));

    api.messages.get.mockResolvedValue(messageWithAttachment(5, '../escaped.txt'));
    api.messages.attachments.get.mockResolvedValue(
      ok({ data: Buffer.from('hi').toString('base64url') }),
    );

    const result = await getAttachment({ messageId: 'm1', attachmentId: 'att1', saveDir: dir });
    expect(result.path).toBe(join(dir, 'escaped.txt'));
    expect(existsSync(result.path!)).toBe(true);
  });

  it('rejects a relative save_dir', async () => {
    api.messages.get.mockResolvedValue(messageWithAttachment(5));
    api.messages.attachments.get.mockResolvedValue(
      ok({ data: Buffer.from('hi').toString('base64url') }),
    );
    await expect(
      getAttachment({ messageId: 'm1', attachmentId: 'att1', saveDir: 'relative/dir' }),
    ).rejects.toThrow(/absolute/);
  });

  it('rejects a save_dir that does not exist', async () => {
    api.messages.get.mockResolvedValue(messageWithAttachment(5));
    api.messages.attachments.get.mockResolvedValue(
      ok({ data: Buffer.from('hi').toString('base64url') }),
    );
    await expect(
      getAttachment({ messageId: 'm1', attachmentId: 'att1', saveDir: '/no/such/dir/here' }),
    ).rejects.toThrow(/does not exist/);
  });

  it('falls back to "attachment" metadata when the part cannot be located', async () => {
    api.messages.get.mockResolvedValue(ok({ id: 'm1', payload: { mimeType: 'text/plain' } }));
    api.messages.attachments.get.mockResolvedValue(
      ok({ data: Buffer.from('hi').toString('base64url') }),
    );

    const result = await getAttachment({ messageId: 'm1', attachmentId: 'ghost' });
    expect(result.filename).toBe('attachment');
    expect(result.mimeType).toBe('application/octet-stream');
    expect(result.data_base64).toBe(Buffer.from('hi').toString('base64'));
  });
});

// ---------------------------------------------------------------------------
// Thread operations
// ---------------------------------------------------------------------------

describe('modifyThread', () => {
  it('modifies the whole thread and returns the union of its labels', async () => {
    api.threads.modify.mockResolvedValue(
      ok({
        id: 't1',
        messages: [
          { id: 'm1', labelIds: ['UNREAD', 'Label_1'] },
          { id: 'm2', labelIds: ['Label_1', 'SENT'] },
        ],
      }),
    );

    await expect(
      modifyThread({ threadId: 't1', addLabelIds: ['Label_1'] }),
    ).resolves.toEqual({
      success: true,
      id: 't1',
      labels: ['UNREAD', 'Label_1', 'SENT'],
    });

    expect(api.threads.modify).toHaveBeenCalledWith({
      userId: 'me',
      id: 't1',
      requestBody: { addLabelIds: ['Label_1'], removeLabelIds: [] },
    });
  });

  it('archives by removing INBOX from every message', async () => {
    api.threads.modify.mockResolvedValue(ok({ id: 't1', messages: [{ labelIds: [] }] }));
    await modifyThread({ threadId: 't1', removeLabelIds: ['INBOX'] });
    expect(api.threads.modify.mock.calls[0][0].requestBody).toEqual({
      addLabelIds: [],
      removeLabelIds: ['INBOX'],
    });
  });

  it('refuses a no-op instead of reporting success', async () => {
    await expect(modifyThread({ threadId: 't1' })).rejects.toThrow(/at least one/);
    await expect(
      modifyThread({ threadId: 't1', addLabelIds: [], removeLabelIds: [] }),
    ).rejects.toThrow(/at least one/);
    expect(api.threads.modify).not.toHaveBeenCalled();
  });
});

describe('trashThread', () => {
  it('trashes the thread and returns its id', async () => {
    api.threads.trash.mockResolvedValue(ok({ id: 't9' }));
    await expect(trashThread({ threadId: 't9' })).resolves.toEqual({
      success: true,
      id: 't9',
    });
    expect(api.threads.trash).toHaveBeenCalledWith({ userId: 'me', id: 't9' });
  });

  it('falls back to the requested id when the API omits one', async () => {
    api.threads.trash.mockResolvedValue(ok({}));
    await expect(trashThread({ threadId: 't9' })).resolves.toMatchObject({ id: 't9' });
  });
});

// ---------------------------------------------------------------------------
// Draft update / delete
// ---------------------------------------------------------------------------

describe('updateDraft', () => {
  beforeEach(() => {
    api.drafts.get.mockResolvedValue(ok({ id: 'd1', message: { threadId: 'thr1' } }));
    api.drafts.update.mockResolvedValue(
      ok({ id: 'd1', message: { id: 'm5', threadId: 'thr1' } }),
    );
  });

  it('replaces the draft through the Gmail-native builder', async () => {
    await expect(
      updateDraft({ draftId: 'd1', to: 'a@b.com', subject: 'Hi', body: 'Hello there' }),
    ).resolves.toEqual({
      draft_id: 'd1',
      message: { id: 'm5', threadId: 'thr1' },
    });

    const call = api.drafts.update.mock.calls[0][0];
    expect(call.id).toBe('d1');
    expect(call.requestBody.id).toBe('d1');

    const raw = Buffer.from(call.requestBody.message.raw, 'base64url').toString('utf8');
    // Same shape as a freshly created draft: multipart/alternative, not a
    // single-part body.
    expect(raw).toContain('Content-Type: multipart/alternative');
    expect(raw).toContain('To: a@b.com');
    expect(raw).toContain('Subject: Hi');
  });

  it('preserves the existing draft threadId so a reply draft stays in its thread', async () => {
    await updateDraft({ draftId: 'd1', to: 'a@b.com', subject: 'Hi', body: 'x' });
    expect(api.drafts.update.mock.calls[0][0].requestBody.message.threadId).toBe('thr1');
  });

  it('omits threadId when the draft has none', async () => {
    api.drafts.get.mockResolvedValue(ok({ id: 'd1', message: {} }));
    await updateDraft({ draftId: 'd1', to: 'a@b.com', subject: 'Hi', body: 'x' });
    expect(api.drafts.update.mock.calls[0][0].requestBody.message.threadId).toBeUndefined();
  });

  it('names the account on a 404 rather than leaking a raw Gmail error', async () => {
    const err = Object.assign(new Error('Not Found'), { code: 404 });
    api.drafts.get.mockRejectedValue(err);
    await expect(
      updateDraft({ draftId: 'gone', to: 'a@b.com', subject: 'Hi', body: 'x', account: 'work' }),
    ).rejects.toThrow(/not found in account "work"/);
  });

  it('sanitizes an injected header in to', async () => {
    await updateDraft({
      draftId: 'd1',
      to: 'a@b.com\r\nBcc: evil@x.com',
      subject: 'Hi',
      body: 'x',
    });
    const raw = Buffer.from(
      api.drafts.update.mock.calls[0][0].requestBody.message.raw,
      'base64url',
    ).toString('utf8');
    expect(raw.split('\r\n\r\n')[0]).not.toMatch(/^Bcc:/m);
  });
});

describe('deleteDraft', () => {
  it('deletes and reports the id', async () => {
    api.drafts.delete.mockResolvedValue(ok({}));
    await expect(deleteDraft({ draftId: 'd7' })).resolves.toEqual({
      success: true,
      draft_id: 'd7',
    });
    expect(api.drafts.delete).toHaveBeenCalledWith({ userId: 'me', id: 'd7' });
  });
});

// ---------------------------------------------------------------------------
// Pagination (list_emails / search_emails / list_drafts)
// ---------------------------------------------------------------------------

describe('listMessages / searchMessages pagination', () => {
  function summaryFor(id: string) {
    return ok({
      id,
      threadId: `t-${id}`,
      labelIds: ['INBOX'],
      snippet: `snippet ${id}`,
      payload: { headers: [{ name: 'Subject', value: `subject ${id}` }] },
    });
  }

  beforeEach(() => {
    api.messages.get.mockImplementation(async ({ id }: { id: string }) => summaryFor(id));
  });

  it('asks for 50 by default, not 500', async () => {
    api.messages.list.mockResolvedValue(ok({ messages: [{ id: 'a' }] }));
    await listMessages({});
    expect(DEFAULT_LIST_PAGE_SIZE).toBe(50);
    expect(api.messages.list.mock.calls[0][0].maxResults).toBe(50);
  });

  it('returns { messages, nextPageToken } and surfaces the cursor', async () => {
    api.messages.list.mockResolvedValue(
      ok({ messages: [{ id: 'a' }, { id: 'b' }], nextPageToken: 'CURSOR' }),
    );
    const page = await listMessages({ maxResults: 2 });
    expect(page.messages.map(m => m.id)).toEqual(['a', 'b']);
    expect(page.nextPageToken).toBe('CURSOR');
  });

  it('omits nextPageToken on the last page', async () => {
    api.messages.list.mockResolvedValue(ok({ messages: [{ id: 'a' }] }));
    const page = await listMessages({ maxResults: 5 });
    expect(page.nextPageToken).toBeUndefined();
    expect(page).not.toHaveProperty('nextPageToken');
  });

  it('passes a caller-supplied page_token straight through', async () => {
    api.messages.list.mockResolvedValue(ok({ messages: [] }));
    await listMessages({ pageToken: 'GIVEN' });
    expect(api.messages.list.mock.calls[0][0].pageToken).toBe('GIVEN');
  });

  it('caps max_results at 500', async () => {
    api.messages.list.mockResolvedValue(ok({ messages: [] }));
    await listMessages({ maxResults: 100_000 });
    expect(api.messages.list.mock.calls[0][0].maxResults).toBe(MAX_LIST_PAGE_SIZE);
  });

  it('defaults the label filter to INBOX and ANDs the query with it', async () => {
    api.messages.list.mockResolvedValue(ok({ messages: [] }));
    await listMessages({ query: 'from:alice' });
    expect(api.messages.list.mock.calls[0][0]).toMatchObject({
      labelIds: ['INBOX'],
      q: 'from:alice',
    });
  });

  it('searchMessages does NOT restrict to a label', async () => {
    api.messages.list.mockResolvedValue(ok({ messages: [] }));
    await searchMessages({ query: 'from:alice' });
    expect(api.messages.list.mock.calls[0][0].labelIds).toBeUndefined();
    expect(api.messages.list.mock.calls[0][0].q).toBe('from:alice');
  });

  it('keeps paging until maxResults is filled', async () => {
    api.messages.list
      .mockResolvedValueOnce(ok({ messages: [{ id: 'a' }], nextPageToken: 'p2' }))
      .mockResolvedValueOnce(ok({ messages: [{ id: 'b' }], nextPageToken: 'p3' }));
    const page = await searchMessages({ query: 'x', maxResults: 2 });
    expect(page.messages.map(m => m.id)).toEqual(['a', 'b']);
    expect(page.nextPageToken).toBe('p3');
    expect(api.messages.list.mock.calls[1][0].pageToken).toBe('p2');
  });
});

describe('listDrafts pagination', () => {
  beforeEach(() => {
    api.messages.get.mockResolvedValue(
      ok({ id: 'm1', threadId: 't1', snippet: 's', payload: { headers: [] } }),
    );
  });

  it('returns { drafts, nextPageToken }', async () => {
    api.drafts.list.mockResolvedValue(
      ok({ drafts: [{ id: 'd1', message: { id: 'm1' } }], nextPageToken: 'D2' }),
    );
    const page = await listDrafts({ maxResults: 1 });
    expect(page.drafts).toHaveLength(1);
    expect(page.drafts[0].draft_id).toBe('d1');
    expect(page.nextPageToken).toBe('D2');
  });

  it('pages, rather than issuing a single un-paginated list', async () => {
    api.drafts.list
      .mockResolvedValueOnce(ok({ drafts: [{ id: 'd1', message: { id: 'm1' } }], nextPageToken: 'p2' }))
      .mockResolvedValueOnce(ok({ drafts: [{ id: 'd2', message: { id: 'm2' } }] }));
    const page = await listDrafts({ maxResults: 2 });
    expect(page.drafts.map(d => d.draft_id)).toEqual(['d1', 'd2']);
    expect(api.drafts.list).toHaveBeenCalledTimes(2);
    expect(api.drafts.list.mock.calls[1][0].pageToken).toBe('p2');
  });

  it('reports the cursor even when the page is empty', async () => {
    api.drafts.list.mockResolvedValue(ok({ drafts: [], nextPageToken: 'X' }));
    await expect(listDrafts({})).resolves.toEqual({ drafts: [], nextPageToken: 'X' });
  });
});

// ---------------------------------------------------------------------------
// read_email formats + get_thread body/attachments
// ---------------------------------------------------------------------------

describe('getMessage formats', () => {
  it('returns a full email for the default format', async () => {
    api.messages.get.mockResolvedValue(
      ok({
        id: 'm1',
        threadId: 't1',
        labelIds: ['INBOX'],
        payload: {
          mimeType: 'text/plain',
          headers: [{ name: 'Subject', value: 'Hi' }],
          body: { data: b64url('the body') },
        },
      }),
    );
    const result = await getMessage({ messageId: 'm1' });
    expect(result).toMatchObject({ subject: 'Hi', body_text: 'the body' });
    expect(result).not.toHaveProperty('body_note');
  });

  it('metadata returns headers plus an explicit body_note, never an empty body', async () => {
    api.messages.get.mockResolvedValue(
      ok({
        id: 'm1',
        threadId: 't1',
        labelIds: ['INBOX'],
        snippet: 'a snippet',
        payload: { headers: [{ name: 'Subject', value: 'Hi' }, { name: 'From', value: 'a@b.com' }] },
      }),
    );
    const result = await getMessage({ messageId: 'm1', format: 'metadata' });
    expect(result).toMatchObject({ subject: 'Hi', from: 'a@b.com', snippet: 'a snippet' });
    expect(result).not.toHaveProperty('body_text');
    expect((result as { body_note: string }).body_note).toMatch(/format "full"/);
  });

  it('minimal says so in the note', async () => {
    api.messages.get.mockResolvedValue(ok({ id: 'm1', threadId: 't1', snippet: 's' }));
    const result = await getMessage({ messageId: 'm1', format: 'minimal' });
    expect((result as { body_note: string }).body_note).toMatch(/minimal/);
  });
});

describe('getThread', () => {
  it('flattens HTML into body_text when there is no text/plain part', async () => {
    api.threads.get.mockResolvedValue(
      ok({
        id: 't1',
        messages: [
          {
            id: 'm1',
            labelIds: [],
            payload: {
              mimeType: 'text/html',
              headers: [{ name: 'Subject', value: 'Hi' }],
              body: { data: b64url('<p>Hello <b>there</b></p>') },
            },
          },
        ],
      }),
    );
    const thread = await getThread({ threadId: 't1' });
    expect(thread.messages[0].body_text).toContain('Hello');
    expect(thread.messages[0].body_text).not.toContain('<p>');
  });

  it('prefers a real text/plain part over the flattened HTML', async () => {
    api.threads.get.mockResolvedValue(
      ok({
        id: 't1',
        messages: [
          {
            id: 'm1',
            labelIds: [],
            payload: {
              mimeType: 'multipart/alternative',
              headers: [],
              parts: [
                { mimeType: 'text/plain', body: { data: b64url('the plain part') } },
                { mimeType: 'text/html', body: { data: b64url('<p>the html part</p>') } },
              ],
            },
          },
        ],
      }),
    );
    const thread = await getThread({ threadId: 't1' });
    expect(thread.messages[0].body_text).toBe('the plain part');
  });

  it('includes per-message attachment metadata', async () => {
    api.threads.get.mockResolvedValue(
      ok({
        id: 't1',
        messages: [
          {
            id: 'm1',
            labelIds: [],
            payload: {
              mimeType: 'multipart/mixed',
              headers: [],
              parts: [
                { mimeType: 'text/plain', body: { data: b64url('body') } },
                {
                  mimeType: 'application/pdf',
                  filename: 'invoice.pdf',
                  body: { attachmentId: 'att1', size: 1234 },
                },
              ],
            },
          },
        ],
      }),
    );
    const thread = await getThread({ threadId: 't1' });
    expect(thread.messages[0].attachments).toEqual([
      { attachmentId: 'att1', filename: 'invoice.pdf', mimeType: 'application/pdf', size: 1234 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

describe('listLabels', () => {
  it('does not report fabricated zero counts', async () => {
    api.labels.list.mockResolvedValue(
      ok({ labels: [{ id: 'INBOX', name: 'INBOX', type: 'system' }] }),
    );
    const labels = await listLabels();
    expect(labels).toEqual([{ id: 'INBOX', name: 'INBOX', type: 'system' }]);
    expect(labels[0]).not.toHaveProperty('messagesTotal');
    expect(api.labels.get).not.toHaveBeenCalled();
  });

  it('fans out labels.get when include_counts is asked for', async () => {
    api.labels.list.mockResolvedValue(
      ok({
        labels: [
          { id: 'INBOX', name: 'INBOX', type: 'system' },
          { id: 'L1', name: 'Receipts', type: 'user' },
        ],
      }),
    );
    api.labels.get.mockImplementation(async ({ id }: { id: string }) =>
      ok({ id, name: id, type: 'user', messagesTotal: 7, messagesUnread: 2 }),
    );

    const labels = await listLabels({ includeCounts: true });
    expect(api.labels.get).toHaveBeenCalledTimes(2);
    expect(labels[0]).toMatchObject({ id: 'INBOX', messagesTotal: 7, messagesUnread: 2 });
    expect(labels[1]).toMatchObject({ id: 'L1', messagesTotal: 7 });
  });

  it('keeps the listing usable when one labels.get fails', async () => {
    api.labels.list.mockResolvedValue(
      ok({ labels: [{ id: 'A', name: 'A' }, { id: 'B', name: 'B' }] }),
    );
    api.labels.get.mockImplementation(async ({ id }: { id: string }) => {
      if (id === 'A') throw Object.assign(new Error('nope'), { code: 400 });
      return ok({ id, name: 'B', messagesTotal: 3 });
    });

    const labels = await listLabels({ includeCounts: true });
    expect(labels.map(l => l.id)).toEqual(['A', 'B']);
    expect(labels[0].messagesTotal).toBeUndefined();
    expect(labels[1].messagesTotal).toBe(3);
  });

  it('surfaces a label colour when the API reports one', async () => {
    api.labels.list.mockResolvedValue(
      ok({
        labels: [
          { id: 'L1', name: 'Hot', color: { textColor: '#ffffff', backgroundColor: '#cc3a21' } },
        ],
      }),
    );
    await expect(listLabels()).resolves.toEqual([
      { id: 'L1', name: 'Hot', type: 'user', textColor: '#ffffff', backgroundColor: '#cc3a21' },
    ]);
  });
});

describe('createLabel colour semantics', () => {
  beforeEach(() => {
    api.labels.create.mockResolvedValue(ok({ id: 'L9', name: 'New', type: 'user' }));
  });

  it('sends no colour at all when neither is given', async () => {
    await createLabel({ name: 'New' });
    expect(api.labels.create.mock.calls[0][0].requestBody.color).toBeUndefined();
  });

  it('sends both when both are given', async () => {
    await createLabel({ name: 'New', textColor: '#ffffff', backgroundColor: '#cc3a21' });
    expect(api.labels.create.mock.calls[0][0].requestBody.color).toEqual({
      textColor: '#ffffff',
      backgroundColor: '#cc3a21',
    });
  });

  it('refuses one colour rather than inventing the other', async () => {
    await expect(createLabel({ name: 'New', backgroundColor: '#cc3a21' })).rejects.toThrow(
      /both text_color and background_color/,
    );
    await expect(createLabel({ name: 'New', textColor: '#ffffff' })).rejects.toThrow(
      /both text_color and background_color/,
    );
    expect(api.labels.create).not.toHaveBeenCalled();
  });
});

describe('updateLabel colour semantics', () => {
  beforeEach(() => {
    api.labels.patch.mockResolvedValue(ok({ id: 'L1', name: 'Renamed', type: 'user' }));
  });

  it('refuses an empty patch instead of reporting success', async () => {
    await expect(updateLabel({ labelId: 'L1' })).rejects.toThrow(/at least one/);
    expect(api.labels.patch).not.toHaveBeenCalled();
  });

  it('renames without touching the colour', async () => {
    await updateLabel({ labelId: 'L1', name: 'Renamed' });
    expect(api.labels.patch.mock.calls[0][0].requestBody).toEqual({ name: 'Renamed' });
    expect(api.labels.get).not.toHaveBeenCalled();
  });

  it('preserves the background when only the text colour changes', async () => {
    api.labels.get.mockResolvedValue(
      ok({ id: 'L1', color: { textColor: '#000000', backgroundColor: '#cc3a21' } }),
    );
    await updateLabel({ labelId: 'L1', textColor: '#ffffff' });
    expect(api.labels.patch.mock.calls[0][0].requestBody.color).toEqual({
      textColor: '#ffffff',
      backgroundColor: '#cc3a21',
    });
  });

  it('preserves the text colour when only the background changes', async () => {
    api.labels.get.mockResolvedValue(
      ok({ id: 'L1', color: { textColor: '#ffffff', backgroundColor: '#000000' } }),
    );
    await updateLabel({ labelId: 'L1', backgroundColor: '#cc3a21' });
    expect(api.labels.patch.mock.calls[0][0].requestBody.color).toEqual({
      textColor: '#ffffff',
      backgroundColor: '#cc3a21',
    });
  });

  it('does not read the label when both colours are supplied', async () => {
    await updateLabel({ labelId: 'L1', textColor: '#ffffff', backgroundColor: '#cc3a21' });
    expect(api.labels.get).not.toHaveBeenCalled();
  });

  it('errors clearly when half a colour is asked for on an uncoloured label', async () => {
    api.labels.get.mockResolvedValue(ok({ id: 'L1' }));
    await expect(updateLabel({ labelId: 'L1', textColor: '#ffffff' })).rejects.toThrow(
      /no colour set/,
    );
  });
});

describe('modifyMessage', () => {
  it('refuses a no-op label call', async () => {
    await expect(modifyMessage({ messageId: 'm1' })).rejects.toThrow(/at least one/);
    expect(api.messages.modify).not.toHaveBeenCalled();
  });

  it('still allows a one-sided call', async () => {
    api.messages.modify.mockResolvedValue(ok({ id: 'm1', labelIds: ['STARRED'] }));
    await expect(modifyMessage({ messageId: 'm1', addLabelIds: ['STARRED'] })).resolves.toEqual({
      success: true,
      id: 'm1',
      labels: ['STARRED'],
    });
  });
});

describe('readDraft on a draft with no message', () => {
  it('explains what is wrong and what to do, instead of a bare one-liner', async () => {
    api.drafts.get.mockResolvedValue(ok({ id: 'd1' }));

    const failure = await readDraft({ draftId: 'd1' }).catch((e: Error) => e);
    const message = (failure as Error).message;

    expect(message).toContain('d1');
    // It says what this state IS, not just that a field was missing.
    expect(message).toMatch(/empty|no content|never saved/i);
    // And it names a way out.
    expect(message).toMatch(/delete_draft|Gmail/);
  });
});

describe('deleteLabel', () => {
  it('deletes and reports the id', async () => {
    api.labels.delete.mockResolvedValue(ok({}));
    await expect(deleteLabel({ labelId: 'L1', confirm: true })).resolves.toEqual({
      success: true,
      labelId: 'L1',
    });
  });

  // G1 — the tool description has always said "confirm with the user first —
  // there is no undo", and nothing checked it.
  it('refuses to delete without confirm, and names the label it would have removed', async () => {
    api.labels.delete.mockResolvedValue(ok({}));
    await expect(deleteLabel({ labelId: 'L1' })).rejects.toThrow(/confirm: true/);
    await expect(deleteLabel({ labelId: 'L1' })).rejects.toThrow(/L1/);
    expect(api.labels.delete).not.toHaveBeenCalled();
  });

  it('refuses before the log line, so a refused delete leaves no "delete_label" trail', async () => {
    api.labels.delete.mockResolvedValue(ok({}));
    await expect(deleteLabel({ labelId: 'L1', confirm: false })).rejects.toThrow();
    expect(api.labels.delete).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// withRetry: 403 rate limits are not authorization failures
// ---------------------------------------------------------------------------

describe('withRetry 403 handling', () => {
  function forbidden(reason?: string) {
    const err = Object.assign(new Error('Forbidden'), { code: 403 }) as Error & {
      code: number;
      errors?: Array<{ reason: string }>;
    };
    if (reason) err.errors = [{ reason }];
    return err;
  }

  it.each(['rateLimitExceeded', 'userRateLimitExceeded'])(
    'retries a 403 whose reason is %s',
    async (reason) => {
      const fn = vi.fn().mockRejectedValueOnce(forbidden(reason)).mockResolvedValue('ok');
      const sleep = vi.fn().mockResolvedValue(undefined);
      await expect(withRetry(fn, { sleep })).resolves.toBe('ok');
      expect(fn).toHaveBeenCalledTimes(2);
    },
  );

  it('reads the reason out of response.data.error.errors too', async () => {
    const err: any = Object.assign(new Error('Forbidden'), { code: 403 });
    err.response = { data: { error: { errors: [{ reason: 'userRateLimitExceeded' }] } } };
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValue('ok');
    await expect(withRetry(fn, { sleep: vi.fn().mockResolvedValue(undefined) })).resolves.toBe('ok');
  });

  it('still tells the user to re-authenticate on an auth-shaped 403', async () => {
    const fn = vi.fn().mockRejectedValue(forbidden('insufficientPermissions'));
    await expect(withRetry(fn, { sleep: vi.fn() })).rejects.toThrow(/Re-authenticate/);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('a 403 with no reason at all is still treated as an auth failure', async () => {
    const fn = vi.fn().mockRejectedValue(forbidden());
    await expect(withRetry(fn, { sleep: vi.fn() })).rejects.toThrow(/Re-authenticate/);
  });

  it('a 401 is never rate-limit-retried, whatever the reason says', async () => {
    const err: any = Object.assign(new Error('nope'), { code: 401 });
    err.errors = [{ reason: 'rateLimitExceeded' }];
    const fn = vi.fn().mockRejectedValue(err);
    await expect(withRetry(fn, { sleep: vi.fn() })).rejects.toThrow(/Re-authenticate/);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('propagates the raw 403 when the rate limit outlasts the retries', async () => {
    const fn = vi.fn().mockRejectedValue(forbidden('rateLimitExceeded'));
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(withRetry(fn, { sleep, maxRetries: 1 })).rejects.toMatchObject({ code: 403 });
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Batch operations
// ---------------------------------------------------------------------------

describe('batchModify', () => {
  it('chunks at Gmail\'s 1000-id limit', async () => {
    api.messages.batchModify.mockResolvedValue(ok({}));
    const ids = Array.from({ length: 2500 }, (_, i) => `id-${i}`);

    const result = await batchModify({ messageIds: ids, removeLabelIds: ['INBOX'] });

    expect(BATCH_MODIFY_CHUNK).toBe(1000);
    expect(api.messages.batchModify).toHaveBeenCalledTimes(3);
    expect(api.messages.batchModify.mock.calls[0][0].requestBody.ids).toHaveLength(1000);
    expect(api.messages.batchModify.mock.calls[2][0].requestBody.ids).toHaveLength(500);
    expect(result.modified_count).toBe(2500);
    expect(result.success).toBe(true);
    expect(result.failures).toBeUndefined();
  });

  it('reports a partial failure instead of discarding what succeeded', async () => {
    const ids = Array.from({ length: 2000 }, (_, i) => `id-${i}`);
    api.messages.batchModify
      .mockResolvedValueOnce(ok({}))
      .mockRejectedValueOnce(Object.assign(new Error('boom'), { code: 400 }));

    const result = await batchModify({ messageIds: ids, addLabelIds: ['L1'] });

    expect(result.success).toBe(false);
    expect(result.modified_count).toBe(1000);
    expect(result.message_ids).toHaveLength(1000);
    expect(result.failures).toHaveLength(1);
    expect(result.failures![0].ids).toHaveLength(1000);
    expect(result.failures![0].error).toMatch(/boom/);
  });

  it('refuses a label no-op', async () => {
    await expect(batchModify({ messageIds: ['a'] })).rejects.toThrow(/at least one/);
    expect(api.messages.batchModify).not.toHaveBeenCalled();
  });
});

describe('batchTrash', () => {
  it('trashes every id and reports the count', async () => {
    api.messages.trash.mockResolvedValue(ok({ id: 'x' }));
    const result = await batchTrash({ messageIds: ['a', 'b', 'c'] });
    expect(api.messages.trash).toHaveBeenCalledTimes(3);
    expect(result).toEqual({
      success: true,
      modified_count: 3,
      message_ids: ['a', 'b', 'c'],
    });
  });

  it('continues past a failure and reports it per id', async () => {
    api.messages.trash.mockImplementation(async ({ id }: { id: string }) => {
      if (id === 'b') throw Object.assign(new Error('gone'), { code: 404 });
      return ok({ id });
    });

    const result = await batchTrash({ messageIds: ['a', 'b', 'c'] });

    expect(result.success).toBe(false);
    expect(result.message_ids).toEqual(['a', 'c']);
    expect(result.modified_count).toBe(2);
    expect(result.failures).toEqual([{ ids: ['b'], error: expect.stringMatching(/gone/) }]);
  });

  it('preserves input order across concurrency chunks', async () => {
    api.messages.trash.mockResolvedValue(ok({}));
    const ids = Array.from({ length: 25 }, (_, i) => `id-${i}`);
    const result = await batchTrash({ messageIds: ids });
    expect(result.message_ids).toEqual(ids);
  });
});

// ---------------------------------------------------------------------------
// unsubscribe: the one outbound request to a URL we did not choose
// ---------------------------------------------------------------------------

describe('unsubscribeFromEmail SSRF guard', () => {
  function headerMessage(listUnsub: string, listUnsubPost = 'List-Unsubscribe=One-Click') {
    return ok({
      id: 'm1',
      payload: {
        headers: [
          { name: 'List-Unsubscribe', value: listUnsub },
          ...(listUnsubPost ? [{ name: 'List-Unsubscribe-Post', value: listUnsubPost }] : []),
        ],
      },
    });
  }

  it('never POSTs to a loopback host, and says why', async () => {
    api.messages.get.mockResolvedValue(headerMessage('<https://localhost/unsub>'));
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const result = await unsubscribeFromEmail({ messageId: 'm1' });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.detail).toMatch(/refused/);
    expect(result.detail).toMatch(/127\.0\.0\.1|::1/);
    fetchSpy.mockRestore();
  });

  it('never POSTs to a plain http:// URL', async () => {
    api.messages.get.mockResolvedValue(headerMessage('<http://legacy.example.com/u>'));
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const result = await unsubscribeFromEmail({ messageId: 'm1' });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.detail).toMatch(/only https/);
    fetchSpy.mockRestore();
  });

  it('refuses every URL in a multi-entry header rather than stopping at the first', async () => {
    api.messages.get.mockResolvedValue(
      headerMessage('<http://a.example.com/u>, <https://localhost/u>'),
    );
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const result = await unsubscribeFromEmail({ messageId: 'm1' });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.detail).toMatch(/only https/);
    expect(result.detail).toMatch(/private\/loopback/);
    fetchSpy.mockRestore();
  });

  it('falls back to the mailto unsubscribe when the URL is refused', async () => {
    api.messages.get.mockResolvedValue(
      headerMessage('<https://localhost/u>, <mailto:unsub@example.com>'),
    );
    api.messages.send.mockResolvedValue(ok({ id: 'sent1' }));
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const result = await unsubscribeFromEmail({ messageId: 'm1', confirm: true });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(api.messages.send).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ success: true, method: 'mailto' });
    expect(result.detail).toMatch(/refused/);
    fetchSpy.mockRestore();
  });

  it('does not follow redirects on the POST it does make', async () => {
    api.messages.get.mockResolvedValue(headerMessage('<https://example.com/unsub>'));
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));

    const result = await unsubscribeFromEmail({ messageId: 'm1' });

    expect(result).toMatchObject({ success: true, method: 'https' });
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    expect(init.redirect).toBe('error');
    expect(init.method).toBe('POST');
    expect(init.signal).toBeDefined();
    fetchSpy.mockRestore();
  });

  it('reports the benign "no header" case without an error flag', async () => {
    api.messages.get.mockResolvedValue(ok({ id: 'm1', payload: { headers: [] } }));
    await expect(unsubscribeFromEmail({ messageId: 'm1' })).resolves.toMatchObject({
      method: 'none',
    });
  });
});

// ---------------------------------------------------------------------------
// G1 — the mailto fallback is a real outbound send and now takes a confirm,
// and "this email has no unsubscribe link" stops being reported as a failure.
// ---------------------------------------------------------------------------

describe('unsubscribeFromEmail confirm gate on the mailto fallback', () => {
  function headerMessage(listUnsub: string, listUnsubPost = 'List-Unsubscribe=One-Click') {
    return ok({
      id: 'm1',
      payload: {
        headers: [
          { name: 'List-Unsubscribe', value: listUnsub },
          ...(listUnsubPost ? [{ name: 'List-Unsubscribe-Post', value: listUnsubPost }] : []),
        ],
      },
    });
  }

  it('refuses to send the unsubscribe mail without confirm, and names what it would send', async () => {
    api.messages.get.mockResolvedValue(headerMessage('<mailto:unsub@example.com?subject=Stop>', ''));
    api.messages.send.mockResolvedValue(ok({ id: 'sent1' }));

    const result = await unsubscribeFromEmail({ messageId: 'm1' });

    expect(api.messages.send).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.method).toBe('mailto');
    expect(result.detail).toMatch(/confirm: true/);
    // It names the recipient and the subject it would have sent.
    expect(result.detail).toMatch(/unsub@example\.com/);
    expect(result.detail).toMatch(/Stop/);
  });

  it('refuses on confirm: false exactly as it does on a missing confirm', async () => {
    api.messages.get.mockResolvedValue(headerMessage('<mailto:unsub@example.com>', ''));
    api.messages.send.mockResolvedValue(ok({ id: 'sent1' }));

    const result = await unsubscribeFromEmail({ messageId: 'm1', confirm: false });

    expect(api.messages.send).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
  });

  it('sends once confirm: true is passed', async () => {
    api.messages.get.mockResolvedValue(headerMessage('<mailto:unsub@example.com>', ''));
    api.messages.send.mockResolvedValue(ok({ id: 'sent1' }));

    const result = await unsubscribeFromEmail({ messageId: 'm1', confirm: true });

    expect(api.messages.send).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ success: true, method: 'mailto' });
  });

  it('still carries the failed HTTPS attempts into the refusal, so the caller sees both facts', async () => {
    api.messages.get.mockResolvedValue(
      headerMessage('<https://localhost/u>, <mailto:unsub@example.com>'),
    );
    api.messages.send.mockResolvedValue(ok({ id: 'sent1' }));

    const result = await unsubscribeFromEmail({ messageId: 'm1' });

    expect(api.messages.send).not.toHaveBeenCalled();
    expect(result.detail).toMatch(/confirm: true/);
    expect(result.detail).toMatch(/refused/);
  });

  it('does NOT gate the one-click HTTPS path — no mail leaves the account there', async () => {
    api.messages.get.mockResolvedValue(headerMessage('<https://example.com/unsub>'));
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));

    const result = await unsubscribeFromEmail({ messageId: 'm1' });

    expect(result).toMatchObject({ success: true, method: 'https' });
    expect(api.messages.send).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('an email with no List-Unsubscribe header is a success with nothing to do, not a failure', async () => {
    api.messages.get.mockResolvedValue(ok({ id: 'm1', payload: { headers: [] } }));

    const result = await unsubscribeFromEmail({ messageId: 'm1' });

    expect(result.success).toBe(true);
    expect(result.method).toBe('none');
    expect(result.detail).toMatch(/nothing to unsubscribe from/i);
  });

  it('a header it cannot parse is still a failure', async () => {
    api.messages.get.mockResolvedValue(headerMessage('garbage-with-no-angle-brackets', ''));

    const result = await unsubscribeFromEmail({ messageId: 'm1' });

    expect(result.success).toBe(false);
    expect(result.method).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// Mailbox history — get_history_baseline / get_mail_changes (Unit D)
// ---------------------------------------------------------------------------

function metaMessage(id: string, subject: string) {
  return ok({
    id,
    threadId: `t-${id}`,
    labelIds: ['INBOX', 'UNREAD'],
    snippet: `snippet ${id}`,
    payload: {
      headers: [
        { name: 'From', value: 'sender@example.com' },
        { name: 'Subject', value: subject },
        { name: 'Date', value: 'Fri, 21 Aug 2026 07:27:00 -0400' },
      ],
    },
  });
}

function apiError(status: number, message = 'boom') {
  const err = new Error(message) as Error & { code: number };
  err.code = status;
  return err;
}

describe('getHistoryBaseline', () => {
  it('returns the mailbox cursor as a string', async () => {
    api.getProfile.mockResolvedValue(
      ok({ emailAddress: 'me@example.com', historyId: '9876543210', messagesTotal: 12, threadsTotal: 7 }),
    );

    const baseline = await getHistoryBaseline({ account: 'work' });

    expect(api.getProfile).toHaveBeenCalledWith({ userId: 'me' });
    expect(baseline).toEqual({
      account: 'work',
      emailAddress: 'me@example.com',
      historyId: '9876543210',
      messagesTotal: 12,
      threadsTotal: 7,
    });
  });

  it('keeps a cursor past 2^53 exact, because a rounded cursor skips mail', async () => {
    // Real Gmail history ids already run into this range; Number() would round.
    api.getProfile.mockResolvedValue(ok({ emailAddress: 'me@example.com', historyId: '9007199254740993' }));

    const baseline = await getHistoryBaseline();

    expect(baseline.historyId).toBe('9007199254740993');
    expect(typeof baseline.historyId).toBe('string');
  });

  it('omits the totals Gmail did not send rather than inventing zeros', async () => {
    api.getProfile.mockResolvedValue(ok({ emailAddress: 'me@example.com', historyId: '5' }));

    const baseline = await getHistoryBaseline();

    expect(baseline).not.toHaveProperty('messagesTotal');
    expect(baseline).not.toHaveProperty('threadsTotal');
  });

  it('errors when Gmail returns no historyId at all', async () => {
    api.getProfile.mockResolvedValue(ok({ emailAddress: 'me@example.com' }));

    await expect(getHistoryBaseline({ account: 'work' })).rejects.toThrow(/no historyId/i);
  });
});

describe('getMailChanges', () => {
  beforeEach(() => {
    api.history.list.mockResolvedValue(ok({ historyId: '200' }));
  });

  it('rejects a cursor that is not a history id, and says where to get one', async () => {
    await expect(getMailChanges({ historyId: 'latest' })).rejects.toThrow(
      /get_history_baseline/,
    );
    expect(api.history.list).not.toHaveBeenCalled();
  });

  it('passes the cursor, filters and page size through', async () => {
    await getMailChanges({
      historyId: '100',
      historyTypes: ['messageAdded'],
      labelId: 'INBOX',
      maxResults: 25,
      pageToken: 'p2',
    });

    expect(api.history.list).toHaveBeenCalledWith({
      userId: 'me',
      startHistoryId: '100',
      maxResults: 25,
      pageToken: 'p2',
      historyTypes: ['messageAdded'],
      labelId: 'INBOX',
    });
  });

  it('defaults the page size and omits the optional filters', async () => {
    await getMailChanges({ historyId: '100' });

    expect(api.history.list).toHaveBeenCalledWith({
      userId: 'me',
      startHistoryId: '100',
      maxResults: DEFAULT_HISTORY_PAGE_SIZE,
    });
  });

  it('clamps the page size to Gmail’s ceiling', async () => {
    await getMailChanges({ historyId: '100', maxResults: 5000 });

    expect(api.history.list.mock.calls[0][0].maxResults).toBe(MAX_HISTORY_PAGE_SIZE);
  });

  it('turns the expired-cursor 404 into a resync instruction', async () => {
    api.history.list.mockRejectedValue(apiError(404, 'Requested entity was not found.'));

    await expect(getMailChanges({ historyId: '100', account: 'work' })).rejects.toThrow(
      /too old.*get_history_baseline.*resync/is,
    );
  });

  // R2-P4: the status was read with `??`, which does not fall through a truthy
  // string. gaxios can set `code` from an underlying error rather than the HTTP
  // status, and a string there swallowed the whole 404-to-resync conversion.
  it('still recognizes the expired cursor when the error code is a string', async () => {
    api.history.list.mockRejectedValue(Object.assign(
      new Error('Requested entity was not found.'),
      { code: 'ERR_BAD_REQUEST', response: { status: 404 } },
    ));

    await expect(getMailChanges({ historyId: '100' })).rejects.toThrow(
      /too old.*get_history_baseline.*resync/is,
    );
  });

  it('does not disguise a non-404 failure as an expired cursor', async () => {
    // 400, not 500: a retryable status would spend the retry budget in real sleeps.
    api.history.list.mockRejectedValue(apiError(400, 'Invalid startHistoryId'));

    const err = await getMailChanges({ historyId: '100' }).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/Invalid startHistoryId/);
    expect((err as Error).message).not.toMatch(/too old/);
  });

  it('groups arrivals, deletions and label changes', async () => {
    api.history.list.mockResolvedValue(
      ok({
        historyId: '250',
        history: [
          { id: '201', messagesAdded: [{ message: { id: 'm1', threadId: 't1', labelIds: ['INBOX'] } }] },
          { id: '202', labelsAdded: [{ message: { id: 'm2', threadId: 't2' }, labelIds: ['STARRED'] }] },
          { id: '203', labelsRemoved: [{ message: { id: 'm3', threadId: 't3' }, labelIds: ['UNREAD'] }] },
          { id: '204', messagesDeleted: [{ message: { id: 'm4', threadId: 't4' } }] },
        ],
      }),
    );
    api.messages.get.mockResolvedValue(metaMessage('m1', 'Hello'));

    const changes = await getMailChanges({ historyId: '200', account: 'work' });

    expect(changes.account).toBe('work');
    expect(changes.fromHistoryId).toBe('200');
    expect(changes.historyId).toBe('250');
    expect(changes.complete).toBe(true);
    expect(changes.added).toHaveLength(1);
    expect(changes.added[0]).toMatchObject({ id: 'm1', subject: 'Hello', isUnread: true });
    expect(changes.labelsAdded).toEqual([{ id: 'm2', threadId: 't2', labelIds: ['STARRED'] }]);
    expect(changes.labelsRemoved).toEqual([{ id: 'm3', threadId: 't3', labelIds: ['UNREAD'] }]);
    expect(changes.deleted).toEqual([{ id: 'm4', threadId: 't4' }]);
  });

  it('returns empty categories, not nulls, for a quiet mailbox', async () => {
    api.history.list.mockResolvedValue(ok({ historyId: '200' }));

    const changes = await getMailChanges({ historyId: '200' });

    expect(changes).toMatchObject({
      historyId: '200',
      complete: true,
      added: [],
      deleted: [],
      labelsAdded: [],
      labelsRemoved: [],
    });
    expect(changes.note).toBeUndefined();
    expect(api.messages.get).not.toHaveBeenCalled();
  });

  it('deduplicates one message named by several records and unions its labels', async () => {
    api.history.list.mockResolvedValue(
      ok({
        historyId: '250',
        history: [
          { id: '201', labelsAdded: [{ message: { id: 'm2', threadId: 't2' }, labelIds: ['STARRED'] }] },
          { id: '202', labelsAdded: [{ message: { id: 'm2', threadId: 't2' }, labelIds: ['IMPORTANT'] }] },
          { id: '203', messagesAdded: [{ message: { id: 'm1', threadId: 't1' } }] },
          { id: '204', messagesAdded: [{ message: { id: 'm1', threadId: 't1' } }] },
        ],
      }),
    );
    api.messages.get.mockResolvedValue(metaMessage('m1', 'Hello'));

    const changes = await getMailChanges({ historyId: '200' });

    expect(changes.labelsAdded).toEqual([
      { id: 'm2', threadId: 't2', labelIds: ['STARRED', 'IMPORTANT'] },
    ]);
    expect(changes.added).toHaveLength(1);
    expect(api.messages.get).toHaveBeenCalledTimes(1);
  });

  it('does not fetch a message that arrived and was deleted in the same window', async () => {
    api.history.list.mockResolvedValue(
      ok({
        historyId: '250',
        history: [
          { id: '201', messagesAdded: [{ message: { id: 'm9', threadId: 't9' } }] },
          { id: '202', messagesDeleted: [{ message: { id: 'm9', threadId: 't9' } }] },
        ],
      }),
    );

    const changes = await getMailChanges({ historyId: '200' });

    expect(api.messages.get).not.toHaveBeenCalled();
    expect(changes.added).toEqual([]);
    expect(changes.deleted).toEqual([{ id: 'm9', threadId: 't9' }]);
  });

  it('degrades one unfetchable arrival to its history record instead of failing the poll', async () => {
    api.history.list.mockResolvedValue(
      ok({
        historyId: '250',
        history: [
          {
            id: '201',
            messagesAdded: [
              { message: { id: 'gone', threadId: 't1', labelIds: ['INBOX', 'UNREAD'] } },
              { message: { id: 'm2', threadId: 't2' } },
            ],
          },
        ],
      }),
    );
    api.messages.get.mockImplementation(async ({ id }: { id: string }) => {
      if (id === 'gone') throw apiError(404, 'Requested entity was not found.');
      return metaMessage('m2', 'Still here');
    });

    const changes = await getMailChanges({ historyId: '200' });

    expect(changes.added).toHaveLength(2);
    expect(changes.added[0]).toMatchObject({
      id: 'gone',
      threadId: 't1',
      subject: '',
      labels: ['INBOX', 'UNREAD'],
      isUnread: true,
    });
    expect(changes.added[1]).toMatchObject({ id: 'm2', subject: 'Still here' });
  });

  it('refuses to advance the cursor while pages remain', async () => {
    api.history.list.mockResolvedValue(
      ok({
        historyId: '900',
        nextPageToken: 'page2',
        history: [{ id: '201', messagesAdded: [{ message: { id: 'm1', threadId: 't1' } }] }],
      }),
    );
    api.messages.get.mockResolvedValue(metaMessage('m1', 'Hello'));

    const changes = await getMailChanges({ historyId: '200' });

    expect(changes.complete).toBe(false);
    expect(changes.nextPageToken).toBe('page2');
    expect(changes.note).toMatch(/SAME history_id/);
    expect(changes.note).toMatch(/complete is true/);
  });

  it('skips every metadata fetch when include_summaries is false', async () => {
    api.history.list.mockResolvedValue(
      ok({
        historyId: '250',
        history: [
          { id: '201', messagesAdded: [{ message: { id: 'm1', threadId: 't1', labelIds: ['INBOX'] } }] },
        ],
      }),
    );

    const changes = await getMailChanges({ historyId: '200', includeSummaries: false });

    expect(api.messages.get).not.toHaveBeenCalled();
    expect(changes.added).toEqual([
      {
        id: 'm1',
        threadId: 't1',
        from: '',
        to: '',
        subject: '',
        date: '',
        snippet: '',
        labels: ['INBOX'],
        isUnread: false,
      },
    ]);
    expect(changes.note).toMatch(/ids and labels only/);
  });

  it('hydrates only up to the cap and says so, instead of a silent fan-out', async () => {
    const overflow = HISTORY_SUMMARY_CAP + 5;
    api.history.list.mockResolvedValue(
      ok({
        historyId: '250',
        history: [
          {
            id: '201',
            messagesAdded: Array.from({ length: overflow }, (_v, i) => ({
              message: { id: `m${i}`, threadId: `t${i}` },
            })),
          },
        ],
      }),
    );
    api.messages.get.mockImplementation(async ({ id }: { id: string }) => metaMessage(id, `Subject ${id}`));

    const changes = await getMailChanges({ historyId: '200' });

    expect(api.messages.get).toHaveBeenCalledTimes(HISTORY_SUMMARY_CAP);
    expect(changes.added).toHaveLength(overflow);
    expect(changes.added[HISTORY_SUMMARY_CAP - 1].subject).not.toBe('');
    expect(changes.added[HISTORY_SUMMARY_CAP].subject).toBe('');
    expect(changes.note).toMatch(new RegExp(`only the first ${HISTORY_SUMMARY_CAP}`));
  });

  it('falls back to the polled cursor when the response omits historyId', async () => {
    api.history.list.mockResolvedValue(ok({}));

    const changes = await getMailChanges({ historyId: '100' });

    expect(changes.historyId).toBe('100');
    expect(changes.complete).toBe(true);
  });

  // R2-P3: a cursor from ANOTHER account can be ahead of this mailbox. Gmail
  // answers 200 with its own, smaller historyId; handing that back as the next
  // cursor walks the caller BACKWARDS and the next poll replays the window.
  it('never hands back a cursor older than the one it was given', async () => {
    api.history.list.mockResolvedValue(ok({ historyId: '500' }));

    const changes = await getMailChanges({ historyId: '9000' });

    expect(changes.historyId).toBe('9000');
    expect(changes.note).toMatch(/9000.*500|older|behind/i);
  });

  it('advances normally when the mailbox has moved forward', async () => {
    api.history.list.mockResolvedValue(ok({ historyId: '9001' }));

    const changes = await getMailChanges({ historyId: '9000' });

    expect(changes.historyId).toBe('9001');
    expect(changes.note).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// inline_images end to end through the composing paths (Unit E)
// ---------------------------------------------------------------------------

describe('inline_images wiring', () => {
  const created: string[] = [];

  async function tmpImage(name: string, bytes = 'PNGDATA'): Promise<string> {
    const { mkdtempSync, writeFileSync } = await import('fs');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const dir = mkdtempSync(join(tmpdir(), 'gmail-inline-'));
    const full = join(dir, name);
    writeFileSync(full, bytes);
    created.push(full);
    return full;
  }

  function sentRaw(): string {
    const raw = api.messages.send.mock.calls[0][0].requestBody.raw as string;
    return Buffer.from(raw, 'base64url').toString('utf8');
  }

  it('send_email embeds the image and references it by cid', async () => {
    const file = await tmpImage('logo.png');
    api.messages.send.mockResolvedValue(ok({ id: 'sent1', threadId: 't1', labelIds: ['SENT'] }));

    await sendMessage({
      to: 'a@b.com',
      subject: 'Hi',
      body: '<p><img src="cid:logo.png"></p>',
      is_html: true,
      inline_images: [file],
    });

    const raw = sentRaw();
    expect(raw).toContain('multipart/related; type="multipart/alternative"');
    expect(raw).toContain('Content-ID: <logo.png>');
    expect(raw).toContain('Content-Disposition: inline; filename="logo.png"');
    expect(raw).toContain(Buffer.from('PNGDATA').toString('base64'));
  });

  it('send_email without inline images is unchanged: no related container', async () => {
    api.messages.send.mockResolvedValue(ok({ id: 'sent1', threadId: 't1', labelIds: ['SENT'] }));

    await sendMessage({ to: 'a@b.com', subject: 'Hi', body: 'plain' });

    expect(sentRaw()).not.toContain('multipart/related');
  });

  it('draft_email carries inline images the same way', async () => {
    const file = await tmpImage('sig.png');
    api.drafts.create.mockResolvedValue(ok({ id: 'd1', message: { id: 'm1', threadId: 't1' } }));

    await createDraft({
      to: 'a@b.com',
      subject: 'Hi',
      body: '<img src="cid:sig.png">',
      is_html: true,
      inline_images: [file],
    });

    const raw = api.drafts.create.mock.calls[0][0].requestBody.message.raw as string;
    expect(Buffer.from(raw, 'base64url').toString('utf8')).toContain('Content-ID: <sig.png>');
  });

  it('reply_email carries inline images alongside the quoted original', async () => {
    const file = await tmpImage('chart.png');
    api.messages.get.mockResolvedValue(
      ok({
        id: 'orig',
        threadId: 't9',
        payload: {
          mimeType: 'text/plain',
          headers: [
            { name: 'From', value: 'Cathy <cathy@example.com>' },
            { name: 'Subject', value: 'Question' },
            { name: 'Date', value: 'Fri, 21 Aug 2026 07:27:00 -0400' },
            { name: 'Message-ID', value: '<abc@mail>' },
          ],
          body: { data: b64url('what do you think?') },
        },
      }),
    );
    api.messages.send.mockResolvedValue(ok({ id: 'sent1', threadId: 't9', labelIds: ['SENT'] }));

    await replyToMessage({
      messageId: 'orig',
      body: '<p>Here: <img src="cid:chart.png"></p>',
      is_html: true,
      inline_images: [file],
    });

    const raw = sentRaw();
    expect(raw).toContain('Content-ID: <chart.png>');
    expect(raw).toContain('multipart/related');
    expect(raw).toContain('In-Reply-To: <abc@mail>');
  });

  it('surfaces the duplicate-cid refusal instead of sending a broken message', async () => {
    const one = await tmpImage('logo.png', 'ONE');
    const { mkdtempSync, writeFileSync } = await import('fs');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const otherDir = mkdtempSync(join(tmpdir(), 'gmail-inline-'));
    const two = join(otherDir, 'logo.png');
    writeFileSync(two, 'TWO');
    created.push(two);

    await expect(
      sendMessage({
        to: 'a@b.com',
        subject: 'Hi',
        body: '<img src="cid:logo.png">',
        is_html: true,
        inline_images: [one, two],
      }),
    ).rejects.toThrow(/share the reference "cid:logo\.png"/);
    expect(api.messages.send).not.toHaveBeenCalled();
  });

  // R2-C3: the parameter said "Requires is_html: true" and nothing enforced it.
  // Without an HTML body the root part is generated by textToHtml, which never
  // writes a cid: reference, so the image rode along referenced by nothing and
  // the tool returned success.
  it('refuses inline images without is_html rather than sending an unreferenced one', async () => {
    const file = await tmpImage('logo.png');

    await expect(
      sendMessage({
        to: 'a@b.com',
        subject: 'Hi',
        body: 'See the logo below.',
        inline_images: [file],
      }),
    ).rejects.toThrow(/inline_images needs is_html: true/);
    expect(api.messages.send).not.toHaveBeenCalled();
  });

  it('refuses inline images with is_html explicitly false', async () => {
    const file = await tmpImage('logo.png');

    await expect(
      createDraft({
        to: 'a@b.com',
        subject: 'Hi',
        body: 'See the logo below.',
        is_html: false,
        inline_images: [file],
      }),
    ).rejects.toThrow(/inline_images needs is_html: true/);
    expect(api.drafts.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Read side: inline parts are listed too (Unit E)
// ---------------------------------------------------------------------------

describe('attachment listing includes inline parts', () => {
  function messageWithInlineImage() {
    return ok({
      id: 'm1',
      threadId: 't1',
      payload: {
        mimeType: 'multipart/related',
        headers: [{ name: 'Subject', value: 'With a picture' }],
        parts: [
          {
            mimeType: 'text/html',
            body: { data: b64url('<img src="cid:ii_abc123">') },
          },
          {
            // A pasted Gmail image: Content-ID, no filename at all.
            mimeType: 'image/png',
            filename: '',
            headers: [
              { name: 'Content-Type', value: 'image/png' },
              { name: 'Content-Disposition', value: 'inline' },
              { name: 'Content-ID', value: '<ii_abc123>' },
            ],
            body: { attachmentId: 'att-inline', size: 2048 },
          },
        ],
      },
    });
  }

  it('lists a cid image that has no filename — it used to be invisible', async () => {
    api.messages.get.mockResolvedValue(messageWithInlineImage());

    const email = await getMessage({ messageId: 'm1' });

    expect(email.attachments).toEqual([
      {
        attachmentId: 'att-inline',
        filename: 'ii_abc123',
        mimeType: 'image/png',
        size: 2048,
        inline: true,
        contentId: 'ii_abc123',
      },
    ]);
  });

  it('does not report the body as an attachment when Gmail offloads it', async () => {
    // A big text/plain body arrives with an attachmentId and no data — and
    // sometimes an inline disposition. It has no Content-ID, so it is a body.
    api.messages.get.mockResolvedValue(
      ok({
        id: 'm1',
        threadId: 't1',
        payload: {
          mimeType: 'multipart/alternative',
          headers: [],
          parts: [
            {
              mimeType: 'text/plain',
              filename: '',
              headers: [{ name: 'Content-Disposition', value: 'inline' }],
              body: { attachmentId: 'body-part', size: 900000 },
            },
          ],
        },
      }),
    );

    const email = await getMessage({ messageId: 'm1' });

    expect(email.attachments).toEqual([]);
  });

  it('leaves a plain attachment unmarked', async () => {
    api.messages.get.mockResolvedValue(
      ok({
        id: 'm1',
        threadId: 't1',
        payload: {
          mimeType: 'multipart/mixed',
          headers: [],
          parts: [
            { mimeType: 'text/plain', body: { data: b64url('hi') } },
            {
              mimeType: 'application/pdf',
              filename: 'report.pdf',
              body: { attachmentId: 'att1', size: 10 },
            },
          ],
        },
      }),
    );

    const email = await getMessage({ messageId: 'm1' });

    expect(email.attachments).toEqual([
      { attachmentId: 'att1', filename: 'report.pdf', mimeType: 'application/pdf', size: 10 },
    ]);
  });

  it('lets get_attachment fetch an inline image, which it previously could not find', async () => {
    api.messages.get.mockResolvedValue(messageWithInlineImage());
    api.messages.attachments.get.mockResolvedValue(
      ok({ size: 7, data: Buffer.from('PNGDATA').toString('base64url') }),
    );

    const result = await getAttachment({ messageId: 'm1', attachmentId: 'att-inline' });

    expect(result).toMatchObject({ filename: 'ii_abc123', mimeType: 'image/png' });
    expect(Buffer.from(result.data_base64!, 'base64').toString()).toBe('PNGDATA');
  });

  it('forwards an embedded image as an embedded image, keeping its cid', async () => {
    api.messages.get.mockResolvedValue(messageWithInlineImage());
    api.messages.attachments.get.mockResolvedValue(
      ok({ size: 7, data: Buffer.from('PNGDATA').toString('base64url') }),
    );
    api.messages.send.mockResolvedValue(ok({ id: 'f1', threadId: 'tf', labelIds: ['SENT'] }));

    await forwardMessage({ messageId: 'm1', to: 'c@d.com' });

    const raw = Buffer.from(
      api.messages.send.mock.calls[0][0].requestBody.raw as string,
      'base64url',
    ).toString('utf8');
    // The forwarded HTML block still says cid:ii_abc123, so the part it points
    // at has to keep that id rather than becoming a loose attachment.
    expect(raw).toContain('multipart/related');
    expect(raw).toContain('Content-ID: <ii_abc123>');
    expect(raw).toContain('Content-Disposition: inline; filename="ii_abc123"');
    // The forwarded HTML itself is base64, so decode the parts to see the
    // reference that makes keeping the Content-ID necessary.
    const decodedParts = raw
      .split(/\r\n\r\n/)
      .slice(1)
      .map(block => block.split(/\r\n--/)[0])
      .filter(block => /^[A-Za-z0-9+/=\r\n]+$/.test(block) && block.trim().length > 0)
      .map(block => Buffer.from(block.replace(/\r\n/g, ''), 'base64').toString('utf8'));
    expect(decodedParts.some(part => part.includes('cid:ii_abc123'))).toBe(true);
  });

  // R2-C2: an Outlook-style chain repeats the signature logo at every quoting
  // level, so the SAME Content-ID appears twice in the part tree. Both copies
  // were pushed into inline_images and the builder's uniqueness check threw
  // before the send — a message that forwarded fine before Unit E.
  function chainRepeatingAContentId() {
    const logoPart = (attachmentId: string) => ({
      mimeType: 'image/png',
      filename: 'image001.png',
      headers: [
        { name: 'Content-Type', value: 'image/png' },
        { name: 'Content-Disposition', value: 'inline' },
        { name: 'Content-ID', value: '<image001.png@01DA0000.11112222>' },
      ],
      body: { attachmentId, size: 512 },
    });
    return ok({
      id: 'm1',
      threadId: 't1',
      payload: {
        mimeType: 'multipart/mixed',
        headers: [{ name: 'Subject', value: 'FW: quarterly numbers' }],
        parts: [
          {
            mimeType: 'multipart/related',
            parts: [
              {
                mimeType: 'text/html',
                body: { data: b64url('<img src="cid:image001.png@01DA0000.11112222">') },
              },
              logoPart('att-outer'),
            ],
          },
          {
            // The quoted original, carrying its own copy of the same logo.
            mimeType: 'message/rfc822',
            parts: [logoPart('att-inner')],
          },
        ],
      },
    });
  }

  it('forwards a chain that repeats a Content-ID instead of refusing to send', async () => {
    api.messages.get.mockResolvedValue(chainRepeatingAContentId());
    api.messages.attachments.get.mockResolvedValue(
      ok({ size: 7, data: Buffer.from('PNGDATA').toString('base64url') }),
    );
    api.messages.send.mockResolvedValue(ok({ id: 'f1', threadId: 'tf', labelIds: ['SENT'] }));

    const read = await getMessage({ messageId: 'm1' });
    expect(read.attachments.filter(a => a.contentId === 'image001.png@01DA0000.11112222'))
      .toHaveLength(2);

    await forwardMessage({ messageId: 'm1', to: 'c@d.com' });

    expect(api.messages.send).toHaveBeenCalledTimes(1);
    const raw = Buffer.from(
      api.messages.send.mock.calls[0][0].requestBody.raw as string,
      'base64url',
    ).toString('utf8');
    // Exactly one copy rides along, under the id the forwarded HTML references.
    const cidHeaders = raw.match(/Content-ID: <image001\.png@01DA0000\.11112222>/g) ?? [];
    expect(cidHeaders).toHaveLength(1);
  });

});

// ---------------------------------------------------------------------------
// G12 — "since last time". The watcher now remembers the last COMPLETE
// position per account, so a routine poll needs no cursor at all. A supplied
// cursor still wins, and a partial read must NOT move the bookmark.
// ---------------------------------------------------------------------------

describe('getMailChanges remembers where it got to', () => {
  const cursors = new Map<string, string>();

  beforeEach(() => {
    cursors.clear();
    cursorStore.readCursor.mockImplementation((alias: string) => cursors.get(alias) ?? null);
    cursorStore.writeCursor.mockImplementation((alias: string, id: string) => {
      const existing = cursors.get(alias);
      if (existing !== undefined && BigInt(id) < BigInt(existing)) {
        return { stored: false, reason: `would rewind the remembered cursor from ${existing}` };
      }
      cursors.set(alias, id);
      return { stored: true };
    });
  });

  it('stores the position after a COMPLETE read', async () => {
    api.history.list.mockResolvedValue(ok({ historyId: '5000', history: [] }));

    await getMailChanges({ historyId: '4000', account: 'work' });

    expect(cursorStore.writeCursor).toHaveBeenCalledWith('work', '5000');
    expect(cursors.get('work')).toBe('5000');
  });

  it('does NOT store while pages remain — that would skip what was not read', async () => {
    api.history.list.mockResolvedValue(
      ok({ historyId: '5000', history: [], nextPageToken: 'page2' }),
    );

    const result = await getMailChanges({ historyId: '4000', account: 'work' });

    expect(result.complete).toBe(false);
    expect(cursorStore.writeCursor).not.toHaveBeenCalled();
  });

  it('continues from the remembered position when no cursor is given', async () => {
    cursors.set('work', '4200');
    api.history.list.mockResolvedValue(ok({ historyId: '5000', history: [] }));

    const result = await getMailChanges({ account: 'work' });

    expect(api.history.list.mock.calls[0][0].startHistoryId).toBe('4200');
    expect(result.fromHistoryId).toBe('4200');
  });

  it('a supplied cursor still wins over the remembered one', async () => {
    cursors.set('work', '4200');
    api.history.list.mockResolvedValue(ok({ historyId: '5000', history: [] }));

    await getMailChanges({ historyId: '100', account: 'work' });

    expect(api.history.list.mock.calls[0][0].startHistoryId).toBe('100');
  });

  it('says what to do when there is nothing remembered and nothing supplied', async () => {
    await expect(getMailChanges({ account: 'work' })).rejects.toThrow(/get_history_baseline/);
    expect(api.history.list).not.toHaveBeenCalled();
  });

  it('never silently starts from "now" — that would report an empty week as no mail', async () => {
    await expect(getMailChanges({ account: 'work' })).rejects.toThrow(/silently|no history_id/i);
  });

  it('reports it when the bookmark could not be moved, rather than implying it was', async () => {
    cursors.set('work', '9000');
    api.history.list.mockResolvedValue(ok({ historyId: '9000', history: [] }));
    cursorStore.writeCursor.mockReturnValue({ stored: false, reason: 'could not be written' });

    const result = await getMailChanges({ historyId: '8000', account: 'work' });

    expect(result.note).toMatch(/remembered cursor was not updated/i);
    expect(result.note).toMatch(/could not be written/);
  });

  it('keeps every account on its own bookmark', async () => {
    api.history.list.mockResolvedValue(ok({ historyId: '5000', history: [] }));
    await getMailChanges({ historyId: '4000', account: 'work' });
    api.history.list.mockResolvedValue(ok({ historyId: '7000', history: [] }));
    await getMailChanges({ historyId: '6000', account: 'personal' });

    expect(cursors.get('work')).toBe('5000');
    expect(cursors.get('personal')).toBe('7000');
  });
});
