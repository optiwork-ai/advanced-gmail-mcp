/**
 * CF1 — create_google_doc: the doc-CREATION half of "Docs write".
 *
 * G11 shipped the editing half (update_google_doc) and silently dropped
 * creation, so "write me a doc" still had nowhere to land. Creation does not go
 * through the Docs API at all: it is a Drive `files.create` whose TARGET
 * mimeType is a Google Doc, with the initial text sent as a plain-text media
 * body that Google converts on upload. That matters because it rides the
 * `drive.file` scope already granted — no consent round, no new scope.
 *
 * These pin the request that is sent to Google, and the refusals that happen
 * before any network call. No real document is touched.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const driveApi = { files: { create: vi.fn() } };

vi.mock('../drive/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../drive/client.js')>();
  return { ...actual, getDriveClient: vi.fn(async () => driveApi) };
});
vi.mock('../config.js', () => ({
  resolveAccount: (input?: string) => ({ alias: input ?? 'work', email: 'me@example.com' }),
}));

const { GOOGLE_DOC_MIME } = await import('../drive/client.js');
const { createGoogleDoc, registerCreateGoogleDoc } = await import('./docs-create-document.js');

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
  registerCreateGoogleDoc(server as never);
  if (!captured) throw new Error('registered nothing');
  return captured;
}

/** Drive's answer to a successful create. */
function created(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      id: 'doc-1',
      name: 'Q3 notes',
      mimeType: GOOGLE_DOC_MIME,
      webViewLink: 'https://docs.google.com/document/d/doc-1/edit',
      ...overrides,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  driveApi.files.create.mockResolvedValue(created());
});

describe('createGoogleDoc', () => {
  it('asks Drive for a real Google Doc, not an uploaded text file', async () => {
    await createGoogleDoc({ title: 'Q3 notes' });

    const args = driveApi.files.create.mock.calls[0][0];
    expect(args.requestBody.mimeType).toBe('application/vnd.google-apps.document');
    expect(args.requestBody.name).toBe('Q3 notes');
    expect(args.supportsAllDrives).toBe(true);
  });

  it('sends initial text as a plain-text body for Google to convert', async () => {
    await createGoogleDoc({ title: 'Q3 notes', initialText: 'line one\nline two\n' });

    const args = driveApi.files.create.mock.calls[0][0];
    expect(args.media).toEqual({ mimeType: 'text/plain', body: 'line one\nline two\n' });
  });

  it('sends no body at all when there is no initial text — an empty doc, not an empty upload', async () => {
    await createGoogleDoc({ title: 'Q3 notes' });

    expect(driveApi.files.create.mock.calls[0][0].media).toBeUndefined();
  });

  it('puts the doc in a folder when one is named, and asks for no parent otherwise', async () => {
    await createGoogleDoc({ title: 'Q3 notes', folderId: 'folder-9' });
    expect(driveApi.files.create.mock.calls[0][0].requestBody.parents).toEqual(['folder-9']);

    driveApi.files.create.mockClear();
    await createGoogleDoc({ title: 'Q3 notes' });
    expect(driveApi.files.create.mock.calls[0][0].requestBody.parents).toBeUndefined();
  });

  it('returns the document id, title and link', async () => {
    const result = await createGoogleDoc({ title: 'Q3 notes' });

    expect(result).toMatchObject({
      documentId: 'doc-1',
      title: 'Q3 notes',
      webViewLink: 'https://docs.google.com/document/d/doc-1/edit',
      account: 'work',
    });
  });

  it('refuses an empty or whitespace title before any network call', async () => {
    await expect(createGoogleDoc({ title: '   ' })).rejects.toThrow(/title/i);
    await expect(createGoogleDoc({ title: '' })).rejects.toThrow(/title/i);
    expect(driveApi.files.create).not.toHaveBeenCalled();
  });

  it('strips control characters out of the title rather than sending them', async () => {
    await createGoogleDoc({ title: 'Q3\nnotes' });

    expect(driveApi.files.create.mock.calls[0][0].requestBody.name).toBe('Q3notes');
  });
});

describe('create_google_doc tool', () => {
  it('leads its description with the fact that it creates a real document', () => {
    const { name, description } = capture();

    expect(name).toBe('create_google_doc');
    expect(description.slice(0, 90).toLowerCase()).toContain('creates a real document');
  });

  it('says the already-granted drive.file scope covers it — no re-consent', () => {
    const { description } = capture();

    expect(description).toContain('drive.file');
    expect(description.toLowerCase()).toMatch(/no re-consent|already granted|no new scope/);
  });

  it('points the caller at update_google_doc for what comes next', async () => {
    const { description, handler } = capture();
    expect(description).toContain('update_google_doc');

    const out = await handler({ title: 'Q3 notes' });
    const payload = JSON.parse(out.content[0].text);
    expect(payload.success).toBe(true);
    expect(payload.documentId).toBe('doc-1');
    expect(String(payload.hint)).toContain('update_google_doc');
  });

  it('reports a refusal as an error instead of throwing', async () => {
    const { handler } = capture();

    const out = await handler({ title: '  ' });
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toMatch(/title/i);
    expect(driveApi.files.create).not.toHaveBeenCalled();
  });
});
