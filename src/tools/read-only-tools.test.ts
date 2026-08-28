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
const driveApi = { files: { list: vi.fn(), get: vi.fn(), export: vi.fn() } };
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
  // Became `documents` on 2026-08-28 when update_google_doc was added; the read
  // tool quotes the scope that is actually requested.
  DOCS_SCOPE: 'https://www.googleapis.com/auth/documents',
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
const { registerReadDriveFile } = await import('./drive-read-file.js');

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
    // WR-3: read_drive_file was the one Drive/Docs read tool left on bare
    // withRetry. Drive's commonest 403 by far is a per-FILE permission, which
    // re-authenticating cannot fix — and after G5 the search hands back files
    // from shared drives the account may only partially reach, so the honesty
    // gap sat directly on the newly widened path.
    label: 'read_drive_file',
    register: registerReadDriveFile,
    mock: driveApi.files.get,
    args: { file_id: 'f1' },
    api: 'Google Drive',
    scope: 'drive.readonly',
  },
  {
    label: 'get_google_doc',
    register: registerGetGoogleDoc,
    mock: docsApi.documents.get,
    args: { document_id: 'doc1' },
    api: 'Google Docs',
    scope: 'auth/documents',
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

  // P4 — the projection dropped deletionMetadata and lastUpdateTime along with
  // the noise, so a DELETED message and an EDITED one came back looking exactly
  // like an ordinary one: name, sender, createTime, text. A reader summarising
  // a space could quote a message the author had already retracted, or an old
  // wording as if it were the current one, with nothing in the answer to warn
  // them. The markers are explicit rather than a raw field, because a consumer
  // should not have to know that "deleteTime is set" is Chat's way of saying
  // deleted.

  it('marks a deleted message as deleted, so it is not read as an ordinary one', async () => {
    chatApi.spaces.messages.list.mockResolvedValue({
      data: {
        messages: [{
          name: 'spaces/A/messages/D',
          createTime: '2026-08-20T10:00:00Z',
          deleteTime: '2026-08-20T11:00:00Z',
          deletionMetadata: { deletionType: 'CREATOR' },
        }],
      },
    });
    const { handler } = capture(registerListChatMessages as (server: never) => void);

    const m = JSON.parse((await handler({ space: 'AAAA' })).content[0].text)[0];

    expect(m.deleted).toBe(true);
    expect(m.deletedBy).toBe('CREATOR');
    expect(m.deleteTime).toBe('2026-08-20T11:00:00Z');
  });

  it('marks an edited message as edited and says when it was last changed', async () => {
    chatApi.spaces.messages.list.mockResolvedValue({
      data: {
        messages: [{
          name: 'spaces/A/messages/E',
          createTime: '2026-08-20T10:00:00Z',
          text: 'the corrected wording',
          lastUpdateTime: '2026-08-20T12:30:00Z',
        }],
      },
    });
    const { handler } = capture(registerListChatMessages as (server: never) => void);

    const m = JSON.parse((await handler({ space: 'AAAA' })).content[0].text)[0];

    expect(m.edited).toBe(true);
    expect(m.lastUpdateTime).toBe('2026-08-20T12:30:00Z');
  });

  it('an ordinary message carries neither marker — they mean something when present', async () => {
    chatApi.spaces.messages.list.mockResolvedValue({ data: { messages: [RAW_MESSAGE] } });
    const { handler } = capture(registerListChatMessages as (server: never) => void);

    const m = JSON.parse((await handler({ space: 'AAAA' })).content[0].text)[0];

    expect(m.deleted).toBeUndefined();
    expect(m.edited).toBeUndefined();
    expect(m.lastUpdateTime).toBeUndefined();
    expect(m.deleteTime).toBeUndefined();
  });

  it('names the two markers in its description', () => {
    const { description } = capture(registerListChatMessages as (server: never) => void);
    expect(description).toContain('deleted');
    expect(description).toContain('edited');
  });
});

// ---------------------------------------------------------------------------
// G5 — files that live in a shared (team) drive were invisible to the search,
// with no message saying so: it looked exactly like the file did not exist.
// ---------------------------------------------------------------------------

describe('search_drive_files sees shared drives', () => {
  beforeEach(() => {
    driveApi.files.list.mockResolvedValue({ data: { files: [] } });
  });

  async function callWith(args: Record<string, unknown>) {
    const { handler } = capture(registerSearchDriveFiles as (server: never) => void);
    await handler(args);
    return driveApi.files.list.mock.calls[0][0] as Record<string, unknown>;
  }

  it('asks for shared-drive items by default — the three flags Google requires together', async () => {
    const params = await callWith({ query: "name contains 'report'" });

    expect(params.supportsAllDrives).toBe(true);
    expect(params.includeItemsFromAllDrives).toBe(true);
    // Without this the other two still search only My Drive.
    expect(params.corpora).toBe('allDrives');
  });

  it('can be narrowed back to the account\'s own Drive', async () => {
    const params = await callWith({ include_shared_drives: false });

    expect(params.includeItemsFromAllDrives).toBe(false);
    expect(params.corpora).toBe('user');
    // Still true: it governs how a shared-drive item is HANDLED, not whether
    // one is searched for, and Google wants it set either way.
    expect(params.supportsAllDrives).toBe(true);
  });

  it('returns driveId, so a result from a shared drive can be told apart', async () => {
    const params = await callWith({});
    expect(String(params.fields)).toContain('driveId');
  });

  it('says in its description that shared drives are included', () => {
    const { description } = capture(registerSearchDriveFiles as (server: never) => void);
    expect(description).toMatch(/shared drive/i);
  });
});

// ---------------------------------------------------------------------------
// WR-1 — the other half of G5. Search now RETURNS shared-drive files; opening
// one has to work too. Drive v3 defaults `supportsAllDrives` to false and
// answers "File not found: <id>" for a shared-drive item when an app has not
// declared support — so without this the round's headline Drive fix makes team
// files visible for the first time and every attempt to open one says the file
// does not exist.
// ---------------------------------------------------------------------------

describe('read_drive_file can open what search now finds', () => {
  /** Run the handler and return the parameters of each files.get call. */
  async function callsFor(meta: Record<string, unknown>, body = 'hello') {
    driveApi.files.get.mockImplementation((params: Record<string, unknown>) =>
      params.alt === 'media'
        ? Promise.resolve({ data: body })
        : Promise.resolve({ data: meta }),
    );
    const { handler } = capture(registerReadDriveFile as (server: never) => void);
    const result = await handler({ file_id: 'f1', account: 'work' });
    return {
      result,
      calls: driveApi.files.get.mock.calls.map(c => c[0] as Record<string, unknown>),
    };
  }

  it('declares shared-drive support on the metadata read, which gates everything after it', async () => {
    const { calls } = await callsFor({ id: 'f1', name: 'notes.txt', mimeType: 'text/plain' });

    expect(calls[0].fileId).toBe('f1');
    expect(calls[0].supportsAllDrives).toBe(true);
  });

  it('declares it on the content read too, so a readable file is not lost at the second call', async () => {
    const { calls } = await callsFor({ id: 'f1', name: 'notes.txt', mimeType: 'text/plain' });

    const media = calls.find(c => c.alt === 'media');
    expect(media).toBeDefined();
    expect(media?.supportsAllDrives).toBe(true);
  });

  it('asks for driveId, so the answer says the file lives in a shared drive', async () => {
    const { calls } = await callsFor({ id: 'f1', name: 'notes.txt', mimeType: 'text/plain' });

    expect(String(calls[0].fields)).toContain('driveId');
  });

  it('still returns the file it read', async () => {
    const { result } = await callsFor(
      { id: 'f1', name: 'notes.txt', mimeType: 'text/plain', driveId: '0AB' },
      'hello',
    );
    const payload = JSON.parse(result.content[0].text);

    expect(result.isError).toBeUndefined();
    expect(payload.content).toBe('hello');
    expect(payload.metadata.driveId).toBe('0AB');
  });
});

// ---------------------------------------------------------------------------
// P2 — the export branch asks for responseType:'stream'. gaxios does not parse
// the body of a NON-2xx stream response: it concatenates it and hands back a
// plain STRING on response.data, with the bare message "Request failed with
// status code N". So every signal the honest-error path reads — the reason
// codes, Google's own sentence — sat unread inside a string, and an export
// 403 came back as "Request failed with status code 403" with no cure in it.
// ---------------------------------------------------------------------------

describe('an export failure whose body arrived as a string still tells the truth', () => {
  const DOC_META = { id: 'd1', name: 'Plan', mimeType: 'application/vnd.google-apps.document' };

  /** gaxios' non-2xx stream shape: data is the raw body text, not an object. */
  function streamError(status: number, body: unknown): Error {
    return Object.assign(new Error(`Request failed with status code ${status}`), {
      code: status,
      response: { status, data: typeof body === 'string' ? body : JSON.stringify(body) },
    });
  }

  async function exportFailing(err: Error) {
    driveApi.files.get.mockResolvedValue({ data: DOC_META });
    driveApi.files.export.mockRejectedValue(err);
    const { handler } = capture(registerReadDriveFile as (server: never) => void);
    const result = await handler({ file_id: 'd1', account: 'work' });
    return result.content[0].text as string;
  }

  it('a missing scope in a string body still names the scope and the re-consent command', async () => {
    const text = await exportFailing(streamError(403, {
      error: {
        code: 403,
        message: 'Request had insufficient authentication scopes.',
        errors: [{ reason: 'insufficientPermissions', message: 'Insufficient Permission' }],
        status: 'PERMISSION_DENIED',
      },
    }));

    expect(text).toContain('drive.readonly');
    expect(text).toContain('npm run auth -- work');
  });

  it('a disabled API in a string body still says to enable it, not to re-authenticate', async () => {
    const text = await exportFailing(streamError(403, {
      error: {
        code: 403,
        message: API_DISABLED('Google Drive'),
        errors: [{ reason: 'accessNotConfigured' }],
      },
    }));

    expect(text).toContain('Google Drive API is not enabled');
    expect(text).toMatch(/will not help/);
  });

  it('an export-only 403 keeps Google\'s own sentence instead of the bare status line', async () => {
    const text = await exportFailing(streamError(403, {
      error: {
        code: 403,
        message: 'This file is too large to be exported.',
        errors: [{ reason: 'exportSizeLimitExceeded' }],
      },
    }));

    expect(text).toContain('This file is too large to be exported.');
    expect(text).toContain('read_drive_file');
    expect(text).not.toMatch(/Re-authenticate with: npx tsx/);
  });

  it('a body that is not JSON at all is left alone rather than crashing the translation', async () => {
    const text = await exportFailing(streamError(403, '<html>upstream said no</html>'));

    expect(text).toContain('Google refused this Google Drive request (403)');
    expect(text).toContain('Request failed with status code 403');
  });
});
