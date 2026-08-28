/**
 * The four read-only Chat / Drive-search / Docs tools, exercised through the
 * handlers the MCP server actually registers.
 *
 * G3: a permission failure from any of them used to arrive as "Authentication
 * error (403) … Re-authenticate", which is the wrong cure for a missing scope,
 * a disabled API, or a resource the account simply cannot see. These pin the
 * honest message instead.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// --- stub the three service clients ---------------------------------------

const chatApi = {
  spaces: {
    list: vi.fn(),
    messages: { list: vi.fn(), get: vi.fn() },
  },
};
const driveApi = { files: { list: vi.fn() } };
const docsApi = { documents: { get: vi.fn() } };

vi.mock('../chat/client.js', () => ({
  getChatClient: vi.fn(async () => chatApi),
  CHAT_SPACES_SCOPE: 'https://www.googleapis.com/auth/chat.spaces.readonly',
  CHAT_MESSAGES_SCOPE: 'https://www.googleapis.com/auth/chat.messages.readonly',
}));
vi.mock('../drive/client.js', () => ({
  getDriveClient: vi.fn(async () => driveApi),
  DRIVE_READONLY_SCOPE: 'https://www.googleapis.com/auth/drive.readonly',
}));
vi.mock('../docs/client.js', () => ({
  getDocsClient: vi.fn(async () => docsApi),
  DOCS_READONLY_SCOPE: 'https://www.googleapis.com/auth/documents.readonly',
}));
vi.mock('../config.js', () => ({
  resolveAccount: (input?: string) => ({
    alias: input ?? 'work',
    email: input?.includes('@') ? input : 'me@example.com',
  }),
}));

const { registerListChatSpaces } = await import('./chat-list-spaces.js');
const { registerListChatMessages } = await import('./chat-list-messages.js');
const { registerSearchDriveFiles } = await import('./drive-search-files.js');
const { registerGetGoogleDoc } = await import('./docs-get-document.js');

// --- a fake McpServer that just captures the handler ----------------------

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function capture(register: (server: never) => void): { name: string; description: string; handler: Handler } {
  let captured: { name: string; description: string; handler: Handler } | undefined;
  const server = {
    tool: (name: string, description: string, _params: unknown, handler: Handler) => {
      captured = { name, description, handler };
    },
  };
  register(server as never);
  if (!captured) throw new Error('the tool registered nothing');
  return captured;
}

/** A Google API error in the shape googleapis actually throws. */
function googleError(status: number, reason: string, message: string): Error {
  return Object.assign(new Error(message), {
    code: status,
    errors: [{ reason }],
    response: { status, data: { error: { errors: [{ reason }] } } },
  });
}

const API_DISABLED = (api: string) =>
  `${api} API has not been used in project 12345 before or it is disabled. `
  + 'Enable it by visiting https://console.developers.google.com/apis/api/x/overview?project=12345 then retry.';

const MISSING_SCOPE = () =>
  Object.assign(new Error('Request had insufficient authentication scopes.'), {
    code: 403,
    errors: [{ reason: 'insufficientPermissions' }],
    response: { status: 403, data: { error: { errors: [{ reason: 'insufficientPermissions' }] } } },
  });

beforeEach(() => {
  vi.clearAllMocks();
});

const cases = [
  {
    label: 'list_chat_spaces',
    register: registerListChatSpaces,
    mock: chatApi.spaces.list,
    args: {},
    api: 'Google Chat',
    scope: 'chat.spaces.readonly',
  },
  {
    label: 'list_chat_messages',
    register: registerListChatMessages,
    mock: chatApi.spaces.messages.list,
    args: { space: 'spaces/AAAA' },
    api: 'Google Chat',
    scope: 'chat.messages.readonly',
  },
  {
    label: 'search_drive_files',
    register: registerSearchDriveFiles,
    mock: driveApi.files.list,
    args: {},
    api: 'Google Drive',
    scope: 'drive.readonly',
  },
  {
    label: 'get_google_doc',
    register: registerGetGoogleDoc,
    mock: docsApi.documents.get,
    args: { document_id: 'doc1' },
    api: 'Google Docs',
    scope: 'documents.readonly',
  },
] as const;

describe.each(cases)('$label tells the truth about a 403', ({ label, register, mock, args, api, scope }) => {
  it('a missing scope names the scope and the re-consent command, not a re-login', async () => {
    mock.mockRejectedValue(MISSING_SCOPE());
    const { handler } = capture(register as (server: never) => void);

    const result = await handler({ ...args, account: 'work' });
    const text = result.content[0].text;

    expect(result.isError).toBe(true);
    expect(text).toContain(scope);
    expect(text).toContain('npm run auth -- work');
    expect(text).not.toMatch(/Re-authenticate with: npx tsx/);
    expect(text).not.toMatch(/^Error: Authentication error/);
  });

  it('a disabled API says to enable it in the console, and that re-authenticating will not help', async () => {
    mock.mockRejectedValue(googleError(403, 'accessNotConfigured', API_DISABLED(api)));
    const { handler } = capture(register as (server: never) => void);

    const result = await handler({ ...args, account: 'work' });
    const text = result.content[0].text;

    expect(text).toContain(`${api} API is not enabled`);
    expect(text).toContain('console.developers.google.com');
    expect(text).toMatch(/will not help/);
    expect(text).not.toMatch(/Re-authenticate with: npx tsx/);
  });

  it('an ordinary forbidden 403 is restated without re-auth advice, keeping Google\'s own words', async () => {
    mock.mockRejectedValue(googleError(403, 'forbidden', 'The caller does not have permission.'));
    const { handler } = capture(register as (server: never) => void);

    const result = await handler({ ...args, account: 'work' });
    const text = result.content[0].text;

    expect(text).toContain('The caller does not have permission.');
    expect(text).toContain(label);
    expect(text).not.toMatch(/Re-authenticate with: npx tsx/);
  });

  it('a 401 is left to the shared re-authenticate path, because there re-login IS the fix', async () => {
    mock.mockRejectedValue(googleError(401, 'authError', 'Invalid Credentials'));
    const { handler } = capture(register as (server: never) => void);

    const result = await handler({ ...args, account: 'work' });

    expect(result.content[0].text).toMatch(/Authentication error \(401\)/);
  });
});

// ---------------------------------------------------------------------------
// G4 — the Chat list tools return the fields they promise, not the whole raw
// Google object. Every listing was paying for dozens of fields nobody asked
// for, and the descriptions named four while handing over everything.
// ---------------------------------------------------------------------------

const RAW_SPACE = {
  name: 'spaces/AAAA',
  displayName: 'Engineering',
  spaceType: 'SPACE',
  spaceDetails: { description: 'the eng room', guidelines: 'be kind' },
  // everything below is what the raw object also carries, and nobody asked for
  type: 'ROOM',
  threaded: true,
  singleUserBotDm: false,
  spaceThreadingState: 'THREADED_MESSAGES',
  spaceHistoryState: 'HISTORY_ON',
  importMode: false,
  createTime: '2024-01-01T00:00:00Z',
  adminInstalled: false,
  spaceUri: 'https://chat.google.com/room/AAAA',
};

const RAW_MESSAGE = {
  name: 'spaces/AAAA/messages/BBBB',
  sender: { name: 'users/1', displayName: 'Cathy Mason', type: 'HUMAN', domainId: 'd1' },
  createTime: '2026-08-20T10:00:00Z',
  text: 'the report is attached',
  thread: { name: 'spaces/AAAA/threads/CCCC', threadKey: 'k' },
  space: RAW_SPACE,
  argumentText: 'the report is attached',
  formattedText: 'the report is attached',
  annotations: [{ type: 'USER_MENTION', startIndex: 0, length: 4 }],
  cardsV2: [{ cardId: 'c1', card: { header: { title: 'big' } } }],
  attachment: [
    { name: 'a/1', contentName: 'report.pdf', contentType: 'application/pdf', source: 'DRIVE_FILE', driveDataRef: { driveFileId: 'x' } },
  ],
  emojiReactionSummaries: [{ emoji: { unicode: '👍' }, reactionCount: 3 }],
  clientAssignedMessageId: '',
  fallbackText: '',
};

describe('list_chat_spaces field projection', () => {
  it('returns exactly the four fields the description promises', async () => {
    chatApi.spaces.list.mockResolvedValue({ data: { spaces: [RAW_SPACE] } });
    const { handler } = capture(registerListChatSpaces as (server: never) => void);

    const result = await handler({});
    const spaces = JSON.parse(result.content[0].text);

    expect(spaces).toHaveLength(1);
    expect(Object.keys(spaces[0]).sort()).toEqual(
      ['displayName', 'name', 'spaceDetails', 'spaceType'].sort(),
    );
    expect(spaces[0]).toMatchObject({
      name: 'spaces/AAAA',
      displayName: 'Engineering',
      spaceType: 'SPACE',
    });
  });

  it('drops an absent field rather than emitting a null for it', async () => {
    chatApi.spaces.list.mockResolvedValue({ data: { spaces: [{ name: 'spaces/D', spaceType: 'DIRECT_MESSAGE' }] } });
    const { handler } = capture(registerListChatSpaces as (server: never) => void);

    const spaces = JSON.parse((await handler({})).content[0].text);
    expect(Object.keys(spaces[0]).sort()).toEqual(['name', 'spaceType']);
  });

  it('says in its description exactly what it returns', () => {
    const { description } = capture(registerListChatSpaces as (server: never) => void);
    for (const field of ['name', 'displayName', 'spaceType', 'spaceDetails']) {
      expect(description).toContain(field);
    }
  });
});

describe('list_chat_messages field projection', () => {
  it('keeps who said what, when, in which thread — and drops the rest', async () => {
    chatApi.spaces.messages.list.mockResolvedValue({ data: { messages: [RAW_MESSAGE] } });
    const { handler } = capture(registerListChatMessages as (server: never) => void);

    const messages = JSON.parse((await handler({ space: 'AAAA' })).content[0].text);
    const m = messages[0];

    expect(m.name).toBe('spaces/AAAA/messages/BBBB');
    expect(m.text).toBe('the report is attached');
    expect(m.createTime).toBe('2026-08-20T10:00:00Z');
    expect(m.sender).toEqual({ name: 'users/1', displayName: 'Cathy Mason', type: 'HUMAN' });
    expect(m.thread).toBe('spaces/AAAA/threads/CCCC');

    // the noise is gone
    expect(m.space).toBeUndefined();
    expect(m.annotations).toBeUndefined();
    expect(m.cardsV2).toBeUndefined();
    expect(m.emojiReactionSummaries).toBeUndefined();
    expect(m.argumentText).toBeUndefined();
  });

  it('does not silently hide that a file was shared', async () => {
    chatApi.spaces.messages.list.mockResolvedValue({ data: { messages: [RAW_MESSAGE] } });
    const { handler } = capture(registerListChatMessages as (server: never) => void);

    const m = JSON.parse((await handler({ space: 'AAAA' })).content[0].text)[0];
    expect(m.attachments).toEqual([{ contentName: 'report.pdf', contentType: 'application/pdf' }]);
  });

  it('a card-only message does not come back looking empty', async () => {
    chatApi.spaces.messages.list.mockResolvedValue({
      data: {
        messages: [
          { name: 'spaces/A/messages/C', text: '', fallbackText: 'Build #42 failed', createTime: 't' },
        ],
      },
    });
    const { handler } = capture(registerListChatMessages as (server: never) => void);

    const m = JSON.parse((await handler({ space: 'AAAA' })).content[0].text)[0];
    expect(m.fallbackText).toBe('Build #42 failed');
  });

  it('says in its description exactly what it returns', () => {
    const { description } = capture(registerListChatMessages as (server: never) => void);
    for (const field of ['name', 'sender', 'createTime', 'text', 'thread']) {
      expect(description).toContain(field);
    }
    expect(description).not.toMatch(/raw Chat message objects/);
  });
});
