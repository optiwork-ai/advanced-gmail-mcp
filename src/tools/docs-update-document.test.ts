/**
 * G11 — update_google_doc, the one write this server makes to a Google Doc.
 *
 * The surface is deliberately narrow: append text at the end, and replace text
 * you can name. No index arithmetic is exposed, because an index is a position
 * in a document the caller cannot see, and getting one wrong edits the wrong
 * paragraph silently.
 *
 * The request builder is pure, so what gets sent to Google is pinned here
 * without touching a real document.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const docsApi = { documents: { batchUpdate: vi.fn(), get: vi.fn() } };

vi.mock('../docs/client.js', () => ({
  getDocsClient: vi.fn(async () => docsApi),
  DOCS_SCOPE: 'https://www.googleapis.com/auth/documents',
}));
vi.mock('../config.js', () => ({
  resolveAccount: (input?: string) => ({ alias: input ?? 'work', email: 'me@example.com' }),
}));

const { buildDocUpdateRequests, registerUpdateGoogleDoc, summarizeDocUpdate } =
  await import('./docs-update-document.js');

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function capture(): { description: string; handler: Handler } {
  let captured: { description: string; handler: Handler } | undefined;
  const server = {
    tool: (_name: string, description: string, _params: unknown, handler: Handler) => {
      captured = { description, handler };
    },
  };
  registerUpdateGoogleDoc(server as never);
  if (!captured) throw new Error('registered nothing');
  return captured;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('buildDocUpdateRequests', () => {
  it('appends with endOfSegmentLocation — never a computed index', () => {
    const requests = buildDocUpdateRequests({ appendText: 'a new line\n' });

    expect(requests).toHaveLength(1);
    expect(requests[0].insertText).toEqual({
      text: 'a new line\n',
      endOfSegmentLocation: { segmentId: '' },
    });
    // The thing this design exists to avoid.
    expect(JSON.stringify(requests)).not.toContain('"index"');
  });

  it('turns each replacement into a replaceAllText request', () => {
    const requests = buildDocUpdateRequests({
      replacements: [
        { find: 'Q3', replace: 'Q4' },
        { find: 'draft', replace: 'final', matchCase: true },
      ],
    });

    expect(requests).toHaveLength(2);
    expect(requests[0].replaceAllText).toEqual({
      containsText: { text: 'Q3', matchCase: false },
      replaceText: 'Q4',
    });
    expect(requests[1].replaceAllText?.containsText?.matchCase).toBe(true);
  });

  it('runs replacements BEFORE the append, so new text is not rewritten by them', () => {
    const requests = buildDocUpdateRequests({
      appendText: 'Q3 summary',
      replacements: [{ find: 'Q3', replace: 'Q4' }],
    });

    expect(requests[0].replaceAllText).toBeDefined();
    expect(requests[1].insertText).toBeDefined();
  });

  it('refuses a call that would do nothing at all', () => {
    expect(() => buildDocUpdateRequests({})).toThrow(/append_text|replacements/);
    expect(() => buildDocUpdateRequests({ replacements: [] })).toThrow(/append_text|replacements/);
  });

  it('refuses an empty search string rather than letting Google decide', () => {
    expect(() => buildDocUpdateRequests({ replacements: [{ find: '', replace: 'x' }] }))
      .toThrow(/empty/i);
    expect(() => buildDocUpdateRequests({ replacements: [{ find: '   ', replace: 'x' }] }))
      .toThrow(/empty/i);
  });

  it('allows replacing text with nothing — deletion is a legitimate edit', () => {
    const requests = buildDocUpdateRequests({ replacements: [{ find: 'TODO', replace: '' }] });
    expect(requests[0].replaceAllText?.replaceText).toBe('');
  });

  it('refuses an empty append rather than sending a no-op insert', () => {
    expect(() => buildDocUpdateRequests({ appendText: '' })).toThrow(/append_text|replacements/);
  });
});

describe('summarizeDocUpdate', () => {
  it('reports how many occurrences each replacement actually changed', () => {
    const summary = summarizeDocUpdate(
      [{ find: 'Q3', replace: 'Q4' }],
      true,
      {
        replies: [{ replaceAllText: { occurrencesChanged: 3 } }, {}],
        writeControl: { requiredRevisionId: 'rev9' },
      },
    );

    expect(summary.replacements).toEqual([{ find: 'Q3', replace: 'Q4', occurrencesChanged: 3 }]);
    expect(summary.appended).toBe(true);
    expect(summary.revisionId).toBe('rev9');
  });

  it('says plainly when a search matched nothing, instead of reporting a clean success', () => {
    const summary = summarizeDocUpdate(
      [{ find: 'nowhere', replace: 'x' }],
      false,
      { replies: [{ replaceAllText: { occurrencesChanged: 0 } }] },
    );

    expect(summary.replacements[0].occurrencesChanged).toBe(0);
    expect(summary.note).toMatch(/matched nothing|no occurrences/i);
  });

  it('has no complaint when everything matched', () => {
    const summary = summarizeDocUpdate(
      [{ find: 'a', replace: 'b' }],
      false,
      { replies: [{ replaceAllText: { occurrencesChanged: 1 } }] },
    );
    expect(summary.note).toBeNull();
  });
});

describe('update_google_doc handler', () => {
  it('sends one batchUpdate and reports what changed', async () => {
    docsApi.documents.batchUpdate.mockResolvedValue({
      data: {
        documentId: 'doc1',
        replies: [{ replaceAllText: { occurrencesChanged: 2 } }],
        writeControl: { requiredRevisionId: 'rev2' },
      },
    });

    const { handler } = capture();
    const result = await handler({
      document_id: 'doc1',
      replacements: [{ find: 'old', replace: 'new' }],
      account: 'work',
    });

    expect(docsApi.documents.batchUpdate).toHaveBeenCalledTimes(1);
    const sent = docsApi.documents.batchUpdate.mock.calls[0][0] as Record<string, unknown>;
    expect(sent.documentId).toBe('doc1');

    const body = JSON.parse(result.content[0].text);
    expect(body.replacements[0].occurrencesChanged).toBe(2);
    expect(body.revisionId).toBe('rev2');
  });

  it('a missing documents scope names that scope and the re-consent command', async () => {
    docsApi.documents.batchUpdate.mockRejectedValue(
      Object.assign(new Error('Request had insufficient authentication scopes.'), {
        code: 403,
        errors: [{ reason: 'insufficientPermissions' }],
        response: { status: 403, data: { error: { errors: [{ reason: 'insufficientPermissions' }] } } },
      }),
    );

    const { handler } = capture();
    const result = await handler({ document_id: 'doc1', append_text: 'x', account: 'work' });

    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain('auth/documents');
    expect(text).toContain('npm run auth -- work');
    expect(text).not.toMatch(/Re-authenticate with: npx tsx/);
  });

  it('refuses a no-op before touching the network', async () => {
    const { handler } = capture();
    const result = await handler({ document_id: 'doc1', account: 'work' });

    expect(result.isError).toBe(true);
    expect(docsApi.documents.batchUpdate).not.toHaveBeenCalled();
  });

  it('says in its description that it edits a real document', () => {
    const { description } = capture();
    expect(description).toMatch(/append/i);
    expect(description).toMatch(/replace/i);
  });
});
