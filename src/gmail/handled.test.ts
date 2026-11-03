/**
 * Contract C (11/03/2026): an email a session handles is filed — marked read,
 * taken out of the inbox and labeled "Handled by Claude".
 *
 * The three send paths that answer an inbox message (reply_email, send_draft of
 * a reply, forward_email) do it after a successful send; mark_handled does it on
 * request. Drafts that are only created change nothing. A cleanup failure never
 * turns a delivered send into an error, and is never silent.
 *
 * googleapis, auth, config and the log are all stubbed: no network, no tokens,
 * no accounts.json, nothing written to the real log.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = {
  messages: { get: vi.fn(), send: vi.fn(), modify: vi.fn() },
  threads: { get: vi.fn(), modify: vi.fn() },
  drafts: { create: vi.fn(), send: vi.fn() },
  labels: { list: vi.fn(), create: vi.fn() },
  settings: { sendAs: { list: vi.fn() } },
};

vi.mock('googleapis', () => ({ google: { gmail: () => ({ users: api }) } }));
vi.mock('./auth.js', () => ({ getAuthClient: vi.fn(async () => ({})) }));
vi.mock('../config.js', () => ({
  resolveAccount: (input?: string) => ({
    alias: input ?? 'test',
    email: input?.includes('@') ? input : 'me@example.com',
  }),
}));
const logSpy = vi.fn();
vi.mock('../log.js', () => ({ log: (...args: unknown[]) => logSpy(...args) }));

const {
  HANDLED_LABEL_NAME,
  createDraft,
  createDraftReply,
  forwardMessage,
  markHandled,
  replyToMessage,
  sendDraft,
} = await import('./client.js');

function ok<T>(data: T) {
  return { data };
}

function apiError(code: number, message: string) {
  return Object.assign(new Error(message), { code });
}

/** A minimal inbox message, as messages.get(format full) returns it. */
function original(id = 'orig', threadId = 't-src') {
  return ok({
    id,
    threadId,
    labelIds: ['INBOX', 'UNREAD'],
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: 'Cathy <cathy@example.com>' },
        { name: 'To', value: 'me@example.com' },
        { name: 'Subject', value: 'Question' },
        { name: 'Date', value: 'Tue, 3 Nov 2026 09:00:00 -0500' },
        { name: 'Message-ID', value: '<abc@mail>' },
      ],
      body: { data: Buffer.from('what do you think?').toString('base64url') },
    },
  });
}

/** Gmail's label store, so "created once" is checked against real state. */
let labels: Array<{ id: string; name: string; type: string }>;

beforeEach(() => {
  vi.clearAllMocks();
  labels = [
    { id: 'INBOX', name: 'INBOX', type: 'system' },
    { id: 'UNREAD', name: 'UNREAD', type: 'system' },
  ];
  api.settings.sendAs.list.mockResolvedValue(ok({ sendAs: [] }));
  api.labels.list.mockImplementation(async () => ok({ labels: [...labels] }));
  api.labels.create.mockImplementation(async ({ requestBody }: { requestBody: { name: string } }) => {
    const label = { id: `Label_${labels.length + 1}`, name: requestBody.name, type: 'user' };
    labels.push(label);
    return ok(label);
  });
  api.threads.modify.mockImplementation(async ({ id }: { id: string }) =>
    ok({ id, messages: [{ id: 'x', labelIds: ['Label_3'] }] }),
  );
});

/** The one threads.modify the cleanup should make. */
function expectFiled(threadId: string) {
  expect(api.threads.modify).toHaveBeenCalledTimes(1);
  const call = api.threads.modify.mock.calls[0][0];
  expect(call.id).toBe(threadId);
  expect(call.requestBody.removeLabelIds.sort()).toEqual(['INBOX', 'UNREAD']);
  const handled = labels.find(l => l.name === HANDLED_LABEL_NAME);
  expect(handled).toBeDefined();
  expect(call.requestBody.addLabelIds).toEqual([handled!.id]);
}

describe('reply_email files the source thread', () => {
  it('marks read, removes INBOX, adds "Handled by Claude" on the source thread', async () => {
    api.messages.get.mockResolvedValue(original());
    api.messages.send.mockResolvedValue(ok({ id: 'sent1', threadId: 't-src', labelIds: ['SENT'] }));

    const result = await replyToMessage({ messageId: 'orig', body: 'Thanks' });

    expect(HANDLED_LABEL_NAME).toBe('Handled by Claude');
    expect(result.id).toBe('sent1');
    expect(result.cleanup).toBe('ok');
    expectFiled('t-src');
  });

  it('creates the label once per account and finds it by name after that', async () => {
    api.messages.get.mockResolvedValue(original());
    api.messages.send.mockResolvedValue(ok({ id: 'sent1', threadId: 't-src', labelIds: ['SENT'] }));

    await replyToMessage({ messageId: 'orig', body: 'one' });
    await replyToMessage({ messageId: 'orig', body: 'two' });

    expect(api.labels.create).toHaveBeenCalledTimes(1);
    expect(api.labels.create.mock.calls[0][0].requestBody.name).toBe('Handled by Claude');
    expect(labels.filter(l => l.name === 'Handled by Claude')).toHaveLength(1);
  });

  it('reuses an existing label whatever its capitalization, never making a second', async () => {
    labels.push({ id: 'Label_77', name: 'handled by claude', type: 'user' });
    api.messages.get.mockResolvedValue(original());
    api.messages.send.mockResolvedValue(ok({ id: 'sent1', threadId: 't-src', labelIds: ['SENT'] }));

    await replyToMessage({ messageId: 'orig', body: 'Thanks' });

    expect(api.labels.create).not.toHaveBeenCalled();
    expect(api.threads.modify.mock.calls[0][0].requestBody.addLabelIds).toEqual(['Label_77']);
  });

  it('a 403 on the label modify after a good send: success, cleanup failed with reason, logged', async () => {
    api.messages.get.mockResolvedValue(original());
    api.messages.send.mockResolvedValue(ok({ id: 'sent1', threadId: 't-src', labelIds: ['SENT'] }));
    api.threads.modify.mockRejectedValue(apiError(403, 'Insufficient Permission'));

    const result = await replyToMessage({ messageId: 'orig', body: 'Thanks' });

    expect(result.id).toBe('sent1');
    expect(result.cleanup).toMatch(/^cleanup failed: .*Insufficient Permission/);
    expect(logSpy).toHaveBeenCalledWith('error', 'handled_cleanup', expect.objectContaining({
      thread_id: 't-src',
      error: expect.stringContaining('Insufficient Permission'),
    }));
  });

  it('a 403 on the label create after a good send: success, cleanup failed with reason', async () => {
    api.messages.get.mockResolvedValue(original());
    api.messages.send.mockResolvedValue(ok({ id: 'sent1', threadId: 't-src', labelIds: ['SENT'] }));
    api.labels.create.mockRejectedValue(apiError(403, 'Request had insufficient authentication scopes.'));

    const result = await replyToMessage({ messageId: 'orig', body: 'Thanks' });

    expect(result.id).toBe('sent1');
    expect(result.cleanup).toMatch(/^cleanup failed: .*insufficient authentication scopes/);
    expect(api.threads.modify).not.toHaveBeenCalled();
  });

  it('a failed send is still an error, and nothing is filed', async () => {
    api.messages.get.mockResolvedValue(original());
    api.messages.send.mockRejectedValue(apiError(400, 'Invalid To header'));

    await expect(replyToMessage({ messageId: 'orig', body: 'Thanks' })).rejects.toThrow('Invalid To header');
    expect(api.threads.modify).not.toHaveBeenCalled();
    expect(api.labels.create).not.toHaveBeenCalled();
  });
});

describe('send_draft files the thread only when the draft is a reply', () => {
  it('a draft replying in an existing thread: that thread is filed', async () => {
    api.drafts.send.mockResolvedValue(ok({ id: 'sent2', threadId: 't-src', labelIds: ['SENT'] }));
    api.threads.get.mockResolvedValue(ok({
      id: 't-src',
      messages: [{ id: 'orig', labelIds: ['INBOX', 'UNREAD'] }, { id: 'sent2', labelIds: ['SENT'] }],
    }));

    const result = await sendDraft({ draftId: 'd1' });

    expect(result.id).toBe('sent2');
    expect(result.cleanup).toBe('ok');
    expectFiled('t-src');
  });

  it('a brand-new message: nothing else is changed', async () => {
    api.drafts.send.mockResolvedValue(ok({ id: 'sent3', threadId: 't-new', labelIds: ['SENT'] }));
    api.threads.get.mockResolvedValue(ok({ id: 't-new', messages: [{ id: 'sent3', labelIds: ['SENT'] }] }));

    const result = await sendDraft({ draftId: 'd2' });

    expect(result.id).toBe('sent3');
    expect(result.cleanup).toBeUndefined();
    expect(api.threads.modify).not.toHaveBeenCalled();
    expect(api.labels.create).not.toHaveBeenCalled();
  });

  it('a failure reading the thread after a good send is reported, not thrown', async () => {
    api.drafts.send.mockResolvedValue(ok({ id: 'sent2', threadId: 't-src', labelIds: ['SENT'] }));
    api.threads.get.mockRejectedValue(apiError(404, 'Requested entity was not found.'));

    const result = await sendDraft({ draftId: 'd1' });

    expect(result.id).toBe('sent2');
    expect(result.cleanup).toMatch(/^cleanup failed: .*Requested entity was not found/);
    expect(api.threads.modify).not.toHaveBeenCalled();
  });
});

describe('forward_email files the forwarded message\'s thread', () => {
  it('files the SOURCE thread, not the new forward thread', async () => {
    api.messages.get.mockResolvedValue(original('m1', 't-src'));
    api.messages.send.mockResolvedValue(ok({ id: 'f1', threadId: 't-fwd', labelIds: ['SENT'] }));

    const result = await forwardMessage({ messageId: 'm1', to: 'c@d.com' });

    expect(result.id).toBe('f1');
    expect(result.cleanup).toBe('ok');
    expectFiled('t-src');
  });
});

describe('drafts that are only created change nothing', () => {
  it('draft_email', async () => {
    api.drafts.create.mockResolvedValue(ok({ id: 'd1', message: { id: 'm', threadId: 't' } }));

    await createDraft({ to: 'a@b.com', subject: 's', body: 'b' });

    expect(api.threads.modify).not.toHaveBeenCalled();
    expect(api.messages.modify).not.toHaveBeenCalled();
    expect(api.labels.create).not.toHaveBeenCalled();
  });

  it('draft_reply', async () => {
    api.messages.get.mockResolvedValue(original());
    api.drafts.create.mockResolvedValue(ok({ id: 'd1', message: { id: 'm', threadId: 't-src' } }));

    await createDraftReply({ messageId: 'orig', body: 'b' });

    expect(api.threads.modify).not.toHaveBeenCalled();
    expect(api.messages.modify).not.toHaveBeenCalled();
    expect(api.labels.create).not.toHaveBeenCalled();
  });
});

describe('markHandled (the mark_handled tool)', () => {
  it('by thread_id: files that thread', async () => {
    const result = await markHandled({ threadId: 't-src', account: 'steve-ah' });

    expect(result).toMatchObject({ success: true, thread_id: 't-src', label: 'Handled by Claude' });
    expectFiled('t-src');
  });

  it('by message_id: looks up the message\'s thread and files it', async () => {
    api.messages.get.mockResolvedValue(ok({ id: 'm9', threadId: 't-9' }));

    const result = await markHandled({ messageId: 'm9' });

    expect(api.messages.get.mock.calls[0][0]).toMatchObject({ id: 'm9', format: 'minimal' });
    expect(result.thread_id).toBe('t-9');
    expectFiled('t-9');
  });

  it('needs exactly one of message_id or thread_id', async () => {
    await expect(markHandled({})).rejects.toThrow(/exactly one of message_id or thread_id/);
    await expect(markHandled({ messageId: 'm', threadId: 't' }))
      .rejects.toThrow(/exactly one of message_id or thread_id/);
    expect(api.threads.modify).not.toHaveBeenCalled();
  });

  it('a failure is an error here (nothing was sent to protect)', async () => {
    api.threads.modify.mockRejectedValue(apiError(403, 'Insufficient Permission'));

    await expect(markHandled({ threadId: 't-src' })).rejects.toThrow('Insufficient Permission');
  });
});
