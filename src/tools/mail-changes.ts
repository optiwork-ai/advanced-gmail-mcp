import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { HISTORY_TYPES, getMailChanges } from '../gmail/client.js';

export const getMailChangesParams = {
  history_id: z.string().describe(
    'The cursor to poll from: the historyId returned by get_history_baseline, or by the last '
    + 'get_mail_changes call whose complete was true. Digits only — pass it back exactly as '
    + 'given, never rounded or reformatted.',
  ),
  account: z.string().optional().describe('Account alias or email address. Must be the SAME account the cursor came from.'),
  history_types: z
    .array(z.enum(HISTORY_TYPES))
    .optional()
    .describe(
      'Restrict to certain change kinds: messageAdded, messageDeleted, labelAdded, labelRemoved. '
      + 'Omit for all four. For a plain "did anything arrive?" watcher, use ["messageAdded"].',
    ),
  label_id: z.string().optional().describe('Only report changes involving this label ID (e.g. INBOX). This is an ID, not a name.'),
  max_results: z.number().optional().describe('History records per page (default: 100, max: 500). One record can name several messages.'),
  page_token: z.string().optional().describe('Cursor for the next page: pass back nextPageToken along with the SAME history_id.'),
  include_summaries: z
    .boolean()
    .optional()
    .describe(
      'Fetch From/Subject/Date for each arrival (default: true). Set false for an ids-only '
      + 'check, which costs one API call instead of one per message.',
    ),
};

export function registerGetMailChanges(server: McpServer): void {
  server.tool(
    'get_mail_changes',
    'List what changed in the mailbox since a history cursor — the mail-arrival watcher. '
    + 'Returns { account, fromHistoryId, historyId, complete, nextPageToken, added, deleted, '
    + 'labelsAdded, labelsRemoved, note }: added carries message summaries, the other three '
    + 'carry ids/threadIds plus the label ids the change involved. '
    + 'Store the returned historyId as your next cursor ONLY when complete is true; while '
    + 'complete is false, call again with the SAME history_id plus the nextPageToken, because '
    + 'the returned cursor is already past the pages you have not read. '
    + 'If the cursor is older than roughly a week Gmail no longer has that history and this '
    + 'errors: get a fresh cursor from get_history_baseline and treat the gap as a full resync '
    + '(list_emails / search_emails), not as "no new mail". Read-only.',
    getMailChangesParams,
    async ({ history_id, account, history_types, label_id, max_results, page_token, include_summaries }) => {
      try {
        const result = await getMailChanges({
          historyId: history_id,
          account: account ?? undefined,
          historyTypes: history_types ?? undefined,
          labelId: label_id ?? undefined,
          maxResults: max_results ?? undefined,
          pageToken: page_token ?? undefined,
          includeSummaries: include_summaries ?? undefined,
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result, null, 2),
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
