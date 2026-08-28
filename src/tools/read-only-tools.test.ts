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
