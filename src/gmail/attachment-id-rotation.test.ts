/**
 * Gmail ROTATES attachmentIds between fetches of the same message.
 *
 * Chair-confirmed live on 2026-08-28: two consecutive
 * `users.messages.get(format:'full')` on message 1a044eb5b67331b1 returned
 * DIFFERENT attachmentIds for the same `ow.png` part. Every other test in this
 * suite mocks a stable id, which is exactly why 735 green tests could not see
 * the defect — so this file mocks the rotation explicitly: the FIRST
 * `messages.get` (the one behind read_email) hands out one id, and every later
 * one hands out another.
 *
 * The consequence being guarded against: `get_attachment` matched the part by
 * attachmentId equality, missed, and fell back to filename "attachment" +
 * `application/octet-stream` — so the image content block never fired on real
 * mail, and a save_dir write got the wrong filename.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  drafts: { list: vi.fn(), get: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), send: vi.fn() },
  labels: { list: vi.fn(), get: vi.fn(), create: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  settings: { sendAs: { list: vi.fn() } },
};

vi.mock('googleapis', () => ({ google: { gmail: () => ({ users: api }) } }));
vi.mock('./auth.js', () => ({ getAuthClient: vi.fn(async () => ({})) }));
vi.mock('./cursor-store.js', () => ({
  readCursor: () => null,
  writeCursor: () => ({ stored: true }),
  cursorFilePath: (alias: string) => `/fake/cursors/${alias}.json`,
}));
vi.mock('../config.js', () => ({
  resolveAccount: (input?: string) => ({ alias: input ?? 'test', email: 'me@example.com' }),
}));

const { getAttachment, getMessage } = await import('./client.js');
const { attachmentContentBlocks } = await import('../tools/get-attachment.js');

/** The picture's real bytes. 512 of them, so the declared size can match. */
const PNG_BYTES = Buffer.alloc(512, 7);

function messageWith(attachmentId: string, extraPart?: Record<string, unknown>) {
  return {
    data: {
      id: 'm1',
      payload: {
        partId: '',
        mimeType: 'multipart/mixed',
        parts: [
          {
            partId: '0',
            mimeType: 'text/plain',
            body: { data: Buffer.from('see picture').toString('base64url') },
          },
          {
            partId: '0.1',
            mimeType: 'image/png',
            filename: 'ow.png',
            body: { attachmentId, size: PNG_BYTES.length },
          },
          ...(extraPart ? [extraPart] : []),
        ],
      },
    },
  };
}

/**
 * Hand out `first` on the first messages.get and `rest` on every one after —
 * which is precisely what Gmail does.
 */
function rotateIds(first: string, rest: string, extraPart?: Record<string, unknown>) {
  let calls = 0;
  api.messages.get.mockImplementation(async () => {
    calls += 1;
    return messageWith(calls === 1 ? first : rest, extraPart);
  });
}

/**
 * The state `get_attachment` actually runs in: read_email already happened in
 * an earlier turn and handed the model `ID-FIRST`, and by the time the fetch
 * comes back to Gmail the part answers to `ID-ROTATED`. Every messages.get
 * from here on reports the new id.
 */
function alreadyRotated(extraPart?: Record<string, unknown>) {
  api.messages.get.mockImplementation(async () => messageWith('ID-ROTATED', extraPart));
}

beforeEach(() => {
  vi.clearAllMocks();
  api.settings.sendAs.list.mockResolvedValue({ data: { sendAs: [] } });
  api.messages.attachments.get.mockResolvedValue({
    data: { size: PNG_BYTES.length, data: PNG_BYTES.toString('base64url') },
  });
});

describe('get_attachment against rotating attachmentIds', () => {
  it('read_email hands out an id that is already stale by the next fetch', async () => {
    rotateIds('ID-FIRST', 'ID-ROTATED');

    const email = await getMessage({ messageId: 'm1' });
    expect(email.attachments[0].attachmentId).toBe('ID-FIRST');
    expect(email.attachments[0].partId).toBe('0.1');

    // Proof the mock really rotates: the same call again reports another id.
    const again = await getMessage({ messageId: 'm1' });
    expect(again.attachments[0].attachmentId).toBe('ID-ROTATED');
    expect(again.attachments[0].partId).toBe('0.1');
  });

  it('identifies the part by size when the id rotated and no part_id was passed', async () => {
    alreadyRotated();

    const result = await getAttachment({ messageId: 'm1', attachmentId: 'ID-FIRST' });

    expect(result.mimeType).toBe('image/png');
    expect(result.filename).toBe('ow.png');
    expect(result.note).toBeUndefined();

    const blocks = attachmentContentBlocks(result);
    expect(blocks.some(b => b.type === 'image')).toBe(true);
  });

  it('identifies the part by part_id when the caller passes it', async () => {
    alreadyRotated();

    const result = await getAttachment({
      messageId: 'm1',
      attachmentId: 'ID-FIRST',
      partId: '0.1',
    });

    expect(result.mimeType).toBe('image/png');
    expect(result.filename).toBe('ow.png');
    expect(result.note).toBeUndefined();

    const blocks = attachmentContentBlocks(result);
    expect(blocks.some(b => b.type === 'image')).toBe(true);
  });

  it('still matches on attachmentId when Gmail happens to keep it stable', async () => {
    api.messages.get.mockImplementation(async () => messageWith('ID-STABLE'));

    const result = await getAttachment({ messageId: 'm1', attachmentId: 'ID-STABLE' });
    expect(result.mimeType).toBe('image/png');
    expect(result.filename).toBe('ow.png');
  });

  it('writes the real filename to save_dir even after a rotation', async () => {
    const { mkdtempSync } = await import('fs');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const dir = mkdtempSync(join(tmpdir(), 'gmail-rot-'));

    alreadyRotated();

    const result = await getAttachment({ messageId: 'm1', attachmentId: 'ID-FIRST', saveDir: dir });
    expect(result.path).toBe(join(dir, 'ow.png'));
    expect(result.mimeType).toBe('image/png');
  });

  it('says so instead of guessing when two parts share the size', async () => {
    // Two same-size candidates: the size fallback must refuse to pick, because
    // a wrong filename written to disk is worse than an honest unknown.
    alreadyRotated({
      partId: '0.2',
      mimeType: 'image/jpeg',
      filename: 'decoy.jpg',
      body: { attachmentId: 'ID-OTHER', size: PNG_BYTES.length },
    });

    const result = await getAttachment({ messageId: 'm1', attachmentId: 'ID-FIRST' });

    expect(result.mimeType).toBe('application/octet-stream');
    expect(result.filename).toBe('attachment');
    expect(result.note).toMatch(/part_id/);

    // …and it does not pretend to be a viewable image.
    const blocks = attachmentContentBlocks(result);
    expect(blocks.every(b => b.type === 'text')).toBe(true);
  });

  it('a wrong part_id falls through to the other matchers rather than failing', async () => {
    alreadyRotated();

    const result = await getAttachment({
      messageId: 'm1',
      attachmentId: 'ID-FIRST',
      partId: '9.9',
    });

    expect(result.mimeType).toBe('image/png');
    expect(result.filename).toBe('ow.png');
  });

  it('refuses an oversized inline read BEFORE downloading when part_id identifies the part', async () => {
    api.messages.get.mockResolvedValue({
      data: {
        id: 'm1',
        payload: {
          partId: '',
          mimeType: 'multipart/mixed',
          parts: [
            {
              partId: '0.1',
              mimeType: 'image/png',
              filename: 'huge.png',
              body: { attachmentId: 'ID-ROTATED', size: 5_000_000 },
            },
          ],
        },
      },
    });

    await expect(
      getAttachment({ messageId: 'm1', attachmentId: 'ID-FIRST', partId: '0.1' }),
    ).rejects.toThrow(/save_dir/);
    expect(api.messages.attachments.get).not.toHaveBeenCalled();
  });

  it('still gates on the fetched length when the part could not be identified', async () => {
    api.messages.get.mockResolvedValue({
      data: { id: 'm1', payload: { partId: '', mimeType: 'text/plain' } },
    });
    const huge = Buffer.alloc(1_200_000, 3);
    api.messages.attachments.get.mockResolvedValue({
      data: { data: huge.toString('base64url') },
    });

    await expect(
      getAttachment({ messageId: 'm1', attachmentId: 'ID-FIRST' }),
    ).rejects.toThrow(/save_dir/);
  });
});
