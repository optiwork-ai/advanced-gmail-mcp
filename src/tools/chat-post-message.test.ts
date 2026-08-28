/**
 * CP2 — post_chat_message.
 *
 * This is the only Chat call that other people can see, so what these pin is
 * mostly about NOT posting: the refusals that happen before any network call,
 * and the honesty of what comes back when Chat does something other than what
 * was asked (a reply that could not be threaded is still a posted message, and
 * saying "replied" would be a lie).
 *
 * Everything is mocked. No message is posted to any real space.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const chatApi = {
  spaces: {
    get: vi.fn(),
    messages: { create: vi.fn(), get: vi.fn() },
  },
};

const logged: Array<{ level: string; message: string; fields: Record<string, unknown> }> = [];

vi.mock('../chat/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../chat/client.js')>();
  return { ...actual, getChatClient: vi.fn(async () => chatApi) };
});
vi.mock('../config.js', () => ({
  resolveAccount: (input?: string) => ({ alias: input ?? 'work', email: 'me@example.com' }),
}));
vi.mock('../log.js', () => ({
  log: (level: string, message: string, fields: Record<string, unknown>) => {
    logged.push({ level, message, fields });
  },
}));

const { CHAT_MESSAGES_CREATE_SCOPE } = await import('../chat/client.js');
const {
  CHAT_TEXT_LIMIT,
  chatTextLength,
  neutralizeChatMentions,
  postChatMessage,
  registerPostChatMessage,
  sanitizeChatText,
} = await import('./chat-post-message.js');

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
  registerPostChatMessage(server as never);
  if (!captured) throw new Error('registered nothing');
  return captured;
}

/** Chat's answer to a successful post. */
function posted(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      name: 'spaces/AAA/messages/MMM',
      createTime: '2026-08-28T18:00:00Z',
      thread: { name: 'spaces/AAA/threads/TTT' },
      ...overrides,
    },
  };
}

/** What Google's client throws when a token lacks a scope. */
function missingScope() {
  const err = new Error('Request had insufficient authentication scopes.') as Error & {
    code: number;
    errors: Array<{ reason: string; message: string }>;
  };
  err.code = 403;
  err.errors = [{ reason: 'insufficientPermissions', message: 'Insufficient Permission' }];
  return err;
}

beforeEach(() => {
  vi.clearAllMocks();
  logged.length = 0;
  chatApi.spaces.messages.create.mockResolvedValue(posted());
  chatApi.spaces.get.mockResolvedValue({ data: { displayName: 'Alerts' } });
  chatApi.spaces.messages.get.mockResolvedValue({
    data: { name: 'spaces/AAA/messages/OLD', thread: { name: 'spaces/AAA/threads/TTT' } },
  });
});

describe('sanitizeChatText', () => {
  it('strips control characters that would render as noise', () => {
    // A NUL and an ANSI colour escape, exactly as they arrive when a log line
    // is pasted into an alert.
    expect(sanitizeChatText('alert \u0000fired \u001B[31mred\u001B[0m')).toBe('alert fired [31mred[0m');
    expect(sanitizeChatText('bell \u0007 delete \u007F')).toBe('bell  delete ');
  });

  it('keeps newlines and tabs — the formatting a plain-text alert uses', () => {
    expect(sanitizeChatText('line one\nline two\tindented')).toBe('line one\nline two\tindented');
  });

  it('turns carriage returns into newlines instead of dropping them', () => {
    expect(sanitizeChatText('a\r\nb\rc')).toBe('a\nb\nc');
  });

  it('leaves ordinary text, emoji and non-ASCII alone', () => {
    expect(sanitizeChatText('Déjà vu 🎉 — done')).toBe('Déjà vu 🎉 — done');
  });
});

/**
 * CP-1 — Chat's `text` field is not inert. `<users/all>` notifies EVERYONE in
 * the space, and message text is routinely composed from something read
 * elsewhere (an email body, a Drive file, a log line) that this server also
 * has access to. So the markup is defused unless the caller says otherwise.
 */
describe('neutralizeChatMentions', () => {
  it('defuses the mention that pages the whole space', () => {
    expect(neutralizeChatMentions('build is red <users/all>')).toEqual({
      text: 'build is red users/all',
      defused: 1,
    });
  });

  it('defuses a mention of one person', () => {
    expect(neutralizeChatMentions('<users/1234567890> please look').text)
      .toBe('users/1234567890 please look');
  });

  it('counts every mention it defused', () => {
    expect(neutralizeChatMentions('<users/all> and <users/123>').defused).toBe(2);
  });

  it('leaves ordinary angle brackets and code alone', () => {
    const text = 'if (a < b) return <div>x</div> — see users/all';
    expect(neutralizeChatMentions(text)).toEqual({ text, defused: 0 });
  });
});

describe('chatTextLength', () => {
  it('counts an emoji as one character, the way a person does', () => {
    expect(chatTextLength('🎉')).toBe(1);
  });
});

describe('postChatMessage — refusals before any call', () => {
  it('refuses a message over Chat\'s limit and posts nothing', async () => {
    const tooLong = 'x'.repeat(CHAT_TEXT_LIMIT + 1);

    await expect(postChatMessage({ space: 'AAA', text: tooLong })).rejects.toThrow(/4097 characters/);
    expect(chatApi.spaces.messages.create).not.toHaveBeenCalled();
    expect(chatApi.spaces.get).not.toHaveBeenCalled();
  });

  it('accepts a message exactly at the limit', async () => {
    await postChatMessage({ space: 'AAA', text: 'x'.repeat(CHAT_TEXT_LIMIT) });
    expect(chatApi.spaces.messages.create).toHaveBeenCalledTimes(1);
  });

  it('measures the limit in characters, not UTF-16 units', async () => {
    // 4096 emoji are 8192 UTF-16 units. Counting units would refuse a message
    // Chat itself accepts.
    await postChatMessage({ space: 'AAA', text: '🎉'.repeat(CHAT_TEXT_LIMIT) });
    expect(chatApi.spaces.messages.create).toHaveBeenCalledTimes(1);
  });

  it('refuses an empty message', async () => {
    await expect(postChatMessage({ space: 'AAA', text: '   \n ' })).rejects.toThrow(/text is required/);
    expect(chatApi.spaces.messages.create).not.toHaveBeenCalled();
  });

  it('refuses thread and thread_key together', async () => {
    await expect(
      postChatMessage({ space: 'AAA', text: 'hi', thread: 'TTT', threadKey: 'k' }),
    ).rejects.toThrow(/not both/);
    expect(chatApi.spaces.messages.create).not.toHaveBeenCalled();
  });

  it('refuses a thread that belongs to another space', async () => {
    await expect(
      postChatMessage({ space: 'AAA', text: 'hi', thread: 'spaces/BBB/threads/TTT' }),
    ).rejects.toThrow(/different Chat space/);
    expect(chatApi.spaces.messages.create).not.toHaveBeenCalled();
  });
});

describe('postChatMessage — the post itself', () => {
  it('posts the text to the normalized space and reports what landed', async () => {
    const result = await postChatMessage({ space: 'AAA', text: 'build is red' });

    const args = chatApi.spaces.messages.create.mock.calls[0][0];
    expect(args.parent).toBe('spaces/AAA');
    expect(args.requestBody.text).toBe('build is red');
    expect(args.requestBody.thread).toBeUndefined();
    expect(args.messageReplyOption).toBeUndefined();

    expect(result).toMatchObject({
      name: 'spaces/AAA/messages/MMM',
      thread: 'spaces/AAA/threads/TTT',
      createTime: '2026-08-28T18:00:00Z',
      space: 'spaces/AAA',
      spaceDisplayName: 'Alerts',
      account: 'work',
    });
    expect(result.repliedToThread).toBeUndefined();
  });

  it('sends the SANITIZED text, not the raw text', async () => {
    await postChatMessage({ space: 'spaces/AAA', text: 'done\u0000 ok' });
    expect(chatApi.spaces.messages.create.mock.calls[0][0].requestBody.text).toBe('done ok');
  });

  it('does not page the whole space with text quoted from somewhere else', async () => {
    // The realistic path: a session summarises an email whose body happens to
    // contain the literal string, and posts the summary as a 3am alert.
    const result = await postChatMessage({
      space: 'AAA',
      text: 'summary of ticket 88: "<users/all> the deploy is stuck"',
    });

    const sent = chatApi.spaces.messages.create.mock.calls[0][0].requestBody.text;
    expect(sent).not.toContain('<users/all>');
    expect(sent).toContain('users/all');
    expect(result.note).toMatch(/mention/i);
    expect(result.mentionsDefused).toBe(1);
  });

  it('lets a deliberate mention through when the caller asks for it', async () => {
    const result = await postChatMessage({
      space: 'AAA',
      text: 'incident open <users/all>',
      allowMentions: true,
    });

    expect(chatApi.spaces.messages.create.mock.calls[0][0].requestBody.text)
      .toBe('incident open <users/all>');
    expect(result.mentionsDefused).toBeUndefined();
  });

  it('still returns the message when the space name cannot be read', async () => {
    chatApi.spaces.get.mockRejectedValue(missingScope());

    const result = await postChatMessage({ space: 'AAA', text: 'hi' });

    expect(result.name).toBe('spaces/AAA/messages/MMM');
    expect(result.spaceDisplayName).toBeUndefined();
  });
});

describe('postChatMessage — threading', () => {
  it('replies into a named thread and says it landed there', async () => {
    const result = await postChatMessage({
      space: 'AAA',
      text: 'on it',
      thread: 'spaces/AAA/threads/TTT',
    });

    const args = chatApi.spaces.messages.create.mock.calls[0][0];
    expect(args.requestBody.thread).toEqual({ name: 'spaces/AAA/threads/TTT' });
    expect(args.messageReplyOption).toBe('REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD');

    expect(result.repliedToThread).toBe(true);
    expect(result.requestedThread).toBe('spaces/AAA/threads/TTT');
    expect(result.note).toBeUndefined();
  });

  it('looks the thread up when given a MESSAGE name', async () => {
    await postChatMessage({ space: 'AAA', text: 'on it', thread: 'spaces/AAA/messages/OLD' });

    expect(chatApi.spaces.messages.get).toHaveBeenCalledWith({ name: 'spaces/AAA/messages/OLD' });
    expect(chatApi.spaces.messages.create.mock.calls[0][0].requestBody.thread).toEqual({
      name: 'spaces/AAA/threads/TTT',
    });
  });

  it('reports the FALLBACK when Chat starts a new thread instead', async () => {
    chatApi.spaces.messages.create.mockResolvedValue(
      posted({ thread: { name: 'spaces/AAA/threads/NEW' } }),
    );

    const result = await postChatMessage({
      space: 'AAA',
      text: 'on it',
      thread: 'spaces/AAA/threads/GONE',
    });

    expect(result.repliedToThread).toBe(false);
    expect(result.thread).toBe('spaces/AAA/threads/NEW');
    expect(result.requestedThread).toBe('spaces/AAA/threads/GONE');
    expect(result.note).toMatch(/NOT into the thread/);
  });

  it('passes thread_key through and asks Chat to fall back rather than fail', async () => {
    const result = await postChatMessage({ space: 'AAA', text: 'nightly', threadKey: 'nightly-run' });

    const args = chatApi.spaces.messages.create.mock.calls[0][0];
    expect(args.requestBody.thread).toEqual({ threadKey: 'nightly-run' });
    expect(args.messageReplyOption).toBe('REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD');
    expect(result.note).toMatch(/thread_key "nightly-run"/);
  });
});

describe('postChatMessage — honest failures', () => {
  it('names the posting scope and the auth command when the token lacks it', async () => {
    chatApi.spaces.messages.create.mockRejectedValue(missingScope());

    await expect(postChatMessage({ space: 'AAA', text: 'hi', account: 'steve-ah' })).rejects.toThrow(
      new RegExp(`${CHAT_MESSAGES_CREATE_SCOPE.replace(/[.]/g, '\\.')}`),
    );

    chatApi.spaces.messages.create.mockRejectedValue(missingScope());
    await expect(postChatMessage({ space: 'AAA', text: 'hi', account: 'steve-ah' })).rejects.toThrow(
      /npm run auth -- steve-ah/,
    );
  });


  it('does NOT retry a transient failure — a retried post is a duplicate message', async () => {
    // 503 is on the shared helper's retry list, and a gateway failure can
    // arrive after Chat has already accepted the message. Retrying would say
    // the same thing twice in front of everyone in the space.
    const err = new Error('Service Unavailable') as Error & { code: number };
    err.code = 503;
    chatApi.spaces.messages.create.mockRejectedValue(err);

    await expect(postChatMessage({ space: 'AAA', text: 'hi' })).rejects.toThrow(/Service Unavailable/);
    expect(chatApi.spaces.messages.create).toHaveBeenCalledTimes(1);
  });

  /**
   * CP-2 — maxRetries:0 stops THIS code duplicating a post, but the caller is
   * an LLM: told only "Service Unavailable", the predictable next move is to
   * call the tool again, which posts the duplicate anyway. Chat's own
   * idempotency key is what makes that retry safe.
   */
  it('sends a request id, which is what makes a retry safe', async () => {
    await postChatMessage({ space: 'AAA', text: 'hi' });

    const sent = chatApi.spaces.messages.create.mock.calls[0][0].requestId;
    expect(typeof sent).toBe('string');
    expect(sent.length).toBeGreaterThan(8);
  });

  it('uses the request id the caller supplied, so their retry returns the same message', async () => {
    const result = await postChatMessage({ space: 'AAA', text: 'hi', requestId: 'nightly-2026-08-28' });

    expect(chatApi.spaces.messages.create.mock.calls[0][0].requestId).toBe('nightly-2026-08-28');
    expect(result.requestId).toBe('nightly-2026-08-28');
  });

  it('says a gateway failure MAY have posted anyway, and how to retry without duplicating', async () => {
    const err = new Error('Service Unavailable') as Error & { code: number };
    err.code = 503;
    chatApi.spaces.messages.create.mockRejectedValue(err);

    await expect(postChatMessage({ space: 'AAA', text: 'hi' })).rejects.toThrow(
      /may already have been posted/i,
    );
    // and it names the space to check and the key that makes a retry safe
    const thrown = await postChatMessage({ space: 'AAA', text: 'hi' }).catch((e: Error) => e.message);
    const used = chatApi.spaces.messages.create.mock.calls[1][0].requestId;
    expect(thrown).toContain('spaces/AAA');
    expect(thrown).toContain(used);
    expect(thrown).toMatch(/request_id/);
    expect(thrown).toMatch(/Service Unavailable/);
  });

  it('does NOT muddy a refusal that never reached the space', async () => {
    // A missing scope is refused by Google before anything is created; saying
    // "it may have posted" there would send someone hunting for a message that
    // does not exist.
    chatApi.spaces.messages.create.mockRejectedValue(missingScope());

    const thrown = await postChatMessage({ space: 'AAA', text: 'hi' }).catch((e: Error) => e.message);
    expect(thrown).not.toMatch(/may already have been posted/i);
  });

  it('does not tell the reader to re-authenticate when Chat refuses the space', async () => {
    const err = new Error('The caller does not have permission') as Error & { code: number };
    err.code = 403;
    chatApi.spaces.messages.create.mockRejectedValue(err);

    await expect(postChatMessage({ space: 'AAA', text: 'hi' })).rejects.toThrow(
      /not a broken login/,
    );
  });
});

describe('postChatMessage — audit log', () => {
  it('logs the start and the done edge, with no message text in either', async () => {
    await postChatMessage({ space: 'AAA', text: 'secret payload' });

    const phases = logged.filter(l => l.message === 'post_chat_message');
    expect(phases.map(p => p.fields.phase)).toEqual(['start', 'done']);
    expect(phases[0].fields).toMatchObject({ account: 'work', space: 'spaces/AAA', text_chars: 14 });
    expect(phases[1].fields).toMatchObject({ message: 'spaces/AAA/messages/MMM' });
    expect(JSON.stringify(phases)).not.toContain('secret payload');
  });

  it('logs a failed edge when the post is refused by Chat', async () => {
    chatApi.spaces.messages.create.mockRejectedValue(missingScope());

    await expect(postChatMessage({ space: 'AAA', text: 'hi' })).rejects.toThrow();

    const phases = logged.filter(l => l.message === 'post_chat_message');
    expect(phases.map(p => p.fields.phase)).toEqual(['start', 'failed']);
    expect(phases[1].level).toBe('error');
  });
});

describe('the registered tool', () => {
  it('leads its description with the fact that real people will see the message', () => {
    const { name, description } = capture();
    expect(name).toBe('post_chat_message');
    expect(description.startsWith('Posts a real message that people in that space will see')).toBe(true);
    expect(description).toContain('sent as');
  });

  it('returns the posted message as JSON', async () => {
    const { handler } = capture();
    const res = await handler({ space: 'AAA', text: 'hi' });

    expect(res.isError).toBeUndefined();
    expect(JSON.parse(res.content[0].text)).toMatchObject({
      success: true,
      name: 'spaces/AAA/messages/MMM',
      account: 'work',
    });
  });

  it('tells the composing model that text is NOT inert', async () => {
    const { description } = capture();
    expect(description).toMatch(/mention/i);
  });

  it('passes allow_mentions through, so a deliberate mention is still possible', async () => {
    const { handler } = capture();
    await handler({ space: 'AAA', text: 'all hands <users/all>', allow_mentions: true });

    expect(chatApi.spaces.messages.create.mock.calls[0][0].requestBody.text)
      .toBe('all hands <users/all>');
  });

  it('returns the refusal as an error, without posting', async () => {
    const { handler } = capture();
    const res = await handler({ space: 'AAA', text: 'x'.repeat(CHAT_TEXT_LIMIT + 1) });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/Nothing was posted/);
    expect(chatApi.spaces.messages.create).not.toHaveBeenCalled();
  });
});
