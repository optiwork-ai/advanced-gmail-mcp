import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { docs_v1 } from 'googleapis';
import { DOCS_SCOPE, getDocsClient } from '../docs/client.js';
import { resolveAccount } from '../config.js';
import { googleApiCall } from '../google-api-error.js';
import { log } from '../log.js';

/**
 * The one write this server makes to a Google Doc.
 *
 * The Docs API is an index-addressed editor: almost every request names a
 * character offset inside the document. Exposing that through a tool would mean
 * a model choosing a number for a position in a document it cannot see, and a
 * number that is wrong by two silently rewrites the wrong paragraph. So the
 * surface here is deliberately two operations that need no arithmetic at all:
 *
 *   - append text at the very end (`endOfSegmentLocation`, not an index);
 *   - replace text you can NAME (`replaceAllText`).
 *
 * Anything more surgical belongs in Docs itself, where the person doing it can
 * see what they are editing.
 */

export interface DocReplacement {
  find: string;
  replace: string;
  matchCase?: boolean;
}

/**
 * Build the batchUpdate requests. Pure, so what is sent to Google can be pinned
 * by tests without a real document.
 *
 * Replacements are ordered BEFORE the append on purpose: a batchUpdate applies
 * its requests in order, so appending first would let a replacement rewrite the
 * text that was just added — which is never what "add this line, and fix that
 * word" means.
 */
export function buildDocUpdateRequests(opts: {
  appendText?: string;
  replacements?: DocReplacement[];
}): docs_v1.Schema$Request[] {
  const replacements = opts.replacements ?? [];
  const appendText = opts.appendText ?? '';

  if (appendText.length === 0 && replacements.length === 0) {
    throw new Error(
      'update_google_doc: nothing to do — pass append_text, replacements, or both. '
      + 'A call with neither would report success while changing nothing.',
    );
  }

  const requests: docs_v1.Schema$Request[] = [];

  for (const replacement of replacements) {
    if (replacement.find.trim().length === 0) {
      throw new Error(
        'update_google_doc: a replacement\'s "find" is empty. An empty search has no meaning '
        + 'here, and letting it through would put the outcome in Google\'s hands rather than '
        + 'stating what was asked for.',
      );
    }
    requests.push({
      replaceAllText: {
        containsText: { text: replacement.find, matchCase: replacement.matchCase ?? false },
        replaceText: replacement.replace,
      },
    });
  }

  if (appendText.length > 0) {
    requests.push({
      insertText: {
        text: appendText,
        // Not an index. This is the API's own "the end of the body", which is
        // the whole reason this tool exposes appending rather than inserting.
        endOfSegmentLocation: { segmentId: '' },
      },
    });
  }

  return requests;
}

export interface DocUpdateSummary {
  replacements: Array<DocReplacement & { occurrencesChanged: number }>;
  appended: boolean;
  revisionId: string | null;
  note: string | null;
}

/**
 * Turn Google's reply into a report a reader can act on.
 *
 * The case that matters is a replacement that matched NOTHING. batchUpdate
 * succeeds either way, so without this the tool would report a clean success
 * for an edit that never happened — and the caller would tell the user the
 * document had been changed.
 */
export function summarizeDocUpdate(
  replacements: DocReplacement[],
  appended: boolean,
  data: docs_v1.Schema$BatchUpdateDocumentResponse,
): DocUpdateSummary {
  const replies = data.replies ?? [];

  const reported = replacements.map((replacement, i) => ({
    ...replacement,
    occurrencesChanged: replies[i]?.replaceAllText?.occurrencesChanged ?? 0,
  }));

  const missed = reported.filter(r => r.occurrencesChanged === 0);
  const note = missed.length === 0
    ? null
    : `${missed.length} of ${reported.length} replacement(s) matched nothing and changed `
      + `nothing: ${missed.map(m => `"${m.find}"`).join(', ')}. The document does not contain `
      + 'that text (check spelling, and matchCase if you set it).';

  return {
    replacements: reported,
    appended,
    revisionId: data.writeControl?.requiredRevisionId ?? null,
    note,
  };
}

export const updateGoogleDocParams = {
  document_id: z.string().describe('The Google Docs document id to edit.'),
  append_text: z
    .string()
    .optional()
    .describe(
      'Text to add at the very END of the document. Include your own newlines — nothing is '
      + 'inserted around it. Omit to make no addition.',
    ),
  replacements: z
    .array(
      z.object({
        find: z.string().describe('The exact text to look for. Must not be empty.'),
        replace: z.string().describe('What to put in its place. An empty string deletes the found text.'),
        match_case: z.boolean().optional().describe('Match capitalisation exactly (default: false).'),
      }),
    )
    .optional()
    .describe(
      'Find-and-replace rules, applied to EVERY occurrence in the document. They run before '
      + 'append_text, so text you add in the same call is not rewritten by them. The result '
      + 'reports how many occurrences each rule actually changed — a rule that matched nothing '
      + 'is called out rather than reported as a success.',
    ),
  account: z.string().optional().describe('Account alias or email address. Uses default account if not specified.'),
};

/**
 * WRITE: edit an existing Google Doc — append text, and/or replace named text.
 */
export function registerUpdateGoogleDoc(server: McpServer): void {
  server.tool(
    'update_google_doc',
    'Edit an existing Google Doc: append text at the end, and/or replace text you name. '
    + 'THIS CHANGES A REAL DOCUMENT the user (or their colleagues) may have open — the edit is '
    + 'immediate, and the only way back is Google Docs\' own version history. '
    + 'There is deliberately no way to insert at a position: a position is a number in a document '
    + 'you cannot see, and a wrong one rewrites the wrong paragraph silently. Append, or replace '
    + 'text you can name. '
    + 'Replacements run before the append, so text added in the same call is not rewritten by them. '
    + 'The result says how many occurrences each replacement actually changed, and calls out any '
    + 'that matched nothing — do not report an edit as done without reading it. '
    + 'REQUIRES the "documents" scope, which replaced "documents.readonly" on 2026-08-28: an '
    + 'account whose token predates it answers 403 until it re-consents with '
    + '"npm run auth -- <alias>".',
    updateGoogleDocParams,
    async ({ document_id, append_text, replacements, account }) => {
      try {
        const rules: DocReplacement[] = (replacements ?? []).map(r => ({
          find: r.find,
          replace: r.replace,
          matchCase: r.match_case ?? false,
        }));

        // Built first: a call that would do nothing, or a rule that cannot mean
        // anything, is refused before a client is even created.
        const requests = buildDocUpdateRequests({
          appendText: append_text ?? undefined,
          replacements: rules,
        });

        const resolved = resolveAccount(account ?? undefined);
        const docs = await getDocsClient(resolved);
        const ctx = {
          tool: 'update_google_doc',
          api: 'Google Docs',
          scope: DOCS_SCOPE,
          alias: resolved.alias,
        };

        const fields = {
          account: resolved.alias,
          document_id,
          replacements: rules.length,
          appended: (append_text ?? '').length > 0,
        };
        log('info', 'update_google_doc', { ...fields, phase: 'start' });

        let response;
        try {
          response = await googleApiCall(ctx, () =>
            docs.documents.batchUpdate({
              documentId: document_id,
              requestBody: { requests },
            }),
          );
        } catch (err: unknown) {
          log('error', 'update_google_doc', {
            ...fields,
            phase: 'failed',
            error: err instanceof Error ? err.message : String(err),
          });
          throw err;
        }
        log('info', 'update_google_doc', { ...fields, phase: 'done' });

        const summary = summarizeDocUpdate(rules, fields.appended, response.data ?? {});

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ success: true, documentId: document_id, ...summary }, null, 2),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
