/**
 * G9 — the audit trail records what HAPPENED, not only what was attempted.
 *
 * Every destructive path logged its intent above the API call and nothing
 * after it. A trash, a thread delete or a draft send that FAILED still left a
 * line in the log saying it had happened, so anyone reading the trail later —
 * including a future session reconstructing what the mailbox did — would
 * believe an action completed that never did.
 *
 * The intent line stays (it is what proves the call was reached at all). Each
 * path now also logs its outcome.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = {
  getProfile: vi.fn(),
  messages: { trash: vi.fn(), batchModify: vi.fn(), get: vi.fn(), send: vi.fn() },
  threads: { get: vi.fn(), modify: vi.fn(), trash: vi.fn() },
  drafts: { delete: vi.fn(), send: vi.fn() },
  labels: { delete: vi.fn() },
  settings: { sendAs: { list: vi.fn() } },
};

vi.mock('googleapis', () => ({ google: { gmail: () => ({ users: api }) } }));
vi.mock('./auth.js', () => ({ getAuthClient: vi.fn(async () => ({})) }));
vi.mock('../config.js', () => ({
  resolveAccount: (input?: string) => ({ alias: input ?? 'test', email: 'me@example.com' }),
}));

const logCalls: Array<{ level: string; message: string; fields: Record<string, unknown> }> = [];
vi.mock('../log.js', () => ({
  log: (level: string, message: string, fields: Record<string, unknown> = {}) => {
    logCalls.push({ level, message, fields });
  },
  getLogPath: () => '/dev/null',
}));

const {
  batchTrash,
  deleteDraft,
  deleteLabel,
  modifyThread,
  sendDraft,
  trashMessage,
  trashThread,
  unsubscribeFromEmail,
} = await import('./client.js');

function ok<T>(data: T) {
  return { data };
}

/** A failure withRetry will not retry: a 404 is final. */
function gone(): Error {
  return Object.assign(new Error('Requested entity was not found.'), { code: 404 });
}

function linesFor(event: string) {
  return logCalls.filter(c => c.message === event);
}

beforeEach(() => {
  vi.clearAllMocks();
  logCalls.length = 0;
  api.settings.sendAs.list.mockResolvedValue(ok({ sendAs: [] }));
});

// Each case: the event name, a success run, and a failure run.
const cases: Array<{
  event: string;
  arm: (fail: boolean) => void;
  run: () => Promise<unknown>;
  identifier: string;
}> = [
  {
    event: 'trash_email',
    identifier: 'message_id',
    arm: fail => fail
      ? api.messages.trash.mockRejectedValue(gone())
      : api.messages.trash.mockResolvedValue(ok({})),
    run: () => trashMessage({ messageId: 'm1' }),
  },
  {
    event: 'batch_trash',
    identifier: 'count',
    arm: fail => fail
      ? api.messages.trash.mockRejectedValue(gone())
      : api.messages.trash.mockResolvedValue(ok({})),
    run: () => batchTrash({ messageIds: ['m1', 'm2'] }),
  },
  {
    event: 'delete_label',
    identifier: 'label_id',
    arm: fail => fail
      ? api.labels.delete.mockRejectedValue(gone())
      : api.labels.delete.mockResolvedValue(ok({})),
    run: () => deleteLabel({ labelId: 'L1', confirm: true }),
  },
  {
    event: 'modify_thread',
    identifier: 'thread_id',
    arm: fail => {
      api.threads.get.mockResolvedValue(ok({ id: 't1', messages: [{ id: 'm1' }] }));
      return fail
        ? api.threads.modify.mockRejectedValue(gone())
        : api.threads.modify.mockResolvedValue(ok({ id: 't1', messages: [{ id: 'm1', labelIds: [] }] }));
    },
    run: () => modifyThread({ threadId: 't1', removeLabelIds: ['INBOX'] }),
  },
  {
    event: 'trash_thread',
    identifier: 'thread_id',
    arm: fail => fail
      ? api.threads.trash.mockRejectedValue(gone())
      : api.threads.trash.mockResolvedValue(ok({ id: 't1' })),
    run: () => trashThread({ threadId: 't1' }),
  },
  {
    event: 'delete_draft',
    identifier: 'draft_id',
    arm: fail => fail
      ? api.drafts.delete.mockRejectedValue(gone())
      : api.drafts.delete.mockResolvedValue(ok({})),
    run: () => deleteDraft({ draftId: 'd1' }),
  },
  {
    event: 'send_draft',
    identifier: 'draft_id',
    arm: fail => fail
      ? api.drafts.send.mockRejectedValue(gone())
      : api.drafts.send.mockResolvedValue(ok({ id: 'm9', threadId: 't9' })),
    run: () => sendDraft({ draftId: 'd1' }),
  },
  {
    // WR-5 — the unsubscribe mailto fallback was the one outbound send still
    // logging its intent and nothing else, so a send that threw left a line
    // indistinguishable from a delivered one. It puts mail in someone else's
    // inbox, which makes it the worst place in the server for that.
    event: 'unsubscribe_mailto',
    identifier: 'message_id',
    arm: fail => {
      api.messages.get.mockResolvedValue(ok({
        id: 'm1',
        payload: { headers: [{ name: 'List-Unsubscribe', value: '<mailto:unsub@example.com>' }] },
      }));
      return fail
        ? api.messages.send.mockRejectedValue(gone())
        : api.messages.send.mockResolvedValue(ok({ id: 'sent1' }));
    },
    run: () => unsubscribeFromEmail({ messageId: 'm1', confirm: true }),
  },
];

describe.each(cases)('$event logs both edges', ({ event, arm, run, identifier }) => {
  it('logs the intent AND the completion when it works', async () => {
    arm(false);
    await run();

    const lines = linesFor(event);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines[0].fields.phase).toBe('start');
    expect(lines[lines.length - 1].fields.phase).toBe('done');
    expect(lines[lines.length - 1].level).toBe('info');
  });

  it('records a FAILURE instead of leaving the intent line standing alone', async () => {
    arm(true);
    await run().catch(() => undefined);

    const lines = linesFor(event);
    const last = lines[lines.length - 1];
    expect(lines[0].fields.phase).toBe('start');
    expect(last.fields.phase).toBe('failed');
    expect(last.level).toBe('error');
    expect(String(last.fields.error)).toMatch(/not found/i);
    // Nothing anywhere in the trail claims this one completed.
    expect(lines.some(l => l.fields.phase === 'done')).toBe(false);
  });

  it('keeps the identifying field on every line, so the edges can be paired up', async () => {
    arm(false);
    await run();

    for (const line of linesFor(event)) {
      expect(line.fields).toHaveProperty(identifier);
      expect(line.fields.account).toBe('test');
    }
  });
});

describe('the intent line is still written before the call', () => {
  it('a failure that never reaches Google still leaves the start line', async () => {
    api.threads.trash.mockRejectedValue(gone());
    await trashThread({ threadId: 't1' }).catch(() => undefined);
    expect(linesFor('trash_thread')[0].fields.phase).toBe('start');
  });

  it('a refused delete_label logs NOTHING at all — the guard runs before the trail', async () => {
    await deleteLabel({ labelId: 'L1' }).catch(() => undefined);
    expect(linesFor('delete_label')).toHaveLength(0);
    expect(api.labels.delete).not.toHaveBeenCalled();
  });
});
