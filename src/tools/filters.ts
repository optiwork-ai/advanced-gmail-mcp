import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createFilter, deleteFilter, listFilters } from '../gmail/settings-api.js';

/**
 * The sentence every tool in this file repeats. The scope was added on
 * 2026-08-27, so until an alias re-consents these tools 403 — and a caller
 * that does not know that reads the 403 as a broken login.
 */
const SCOPE_NOTE =
  'REQUIRES the "gmail.settings.basic" scope, added on 2026-08-27: an account whose token '
  + 'predates it answers 403 until it re-consents with "npm run auth -- <alias>". A 403 from '
  + 'this tool means the permission was never granted, not that the login is broken.';

const accountParam = z.string().optional().describe('Account alias or email address. Uses default account if not specified.');

export const listFiltersParams = { account: accountParam };

export const createFilterParams = {
  from: z.string().optional().describe('Match the sender, e.g. "notifications@github.com" or a bare domain.'),
  to: z.string().optional().describe('Match the recipient (useful for a plus-address or an alias).'),
  subject: z.string().optional().describe('Match words in the subject.'),
  query: z.string().optional().describe('Full Gmail search syntax the message must match, e.g. "has:attachment older_than:1y".'),
  negated_query: z.string().optional().describe('Gmail search syntax the message must NOT match.'),
  has_attachment: z.boolean().optional().describe('Match only messages with an attachment.'),
  exclude_chats: z.boolean().optional().describe('Exclude chat messages from the match.'),
  add_label_ids: z.array(z.string()).optional().describe('Label IDs to ADD to matching mail (from get_labels). Gmail\'s built-ins are usable here and are how a filter archives or deletes: adding "TRASH" TRASHES every matching message, and there is no undo beyond emptying the trash.'),
  remove_label_ids: z.array(z.string()).optional().describe('Label IDs to REMOVE from matching mail. Removing "INBOX" is how a filter archives; removing "UNREAD" marks it read.'),
  account: accountParam,
};

export const deleteFilterParams = {
  filter_id: z.string().describe('The filter id to delete (from list_filters).'),
  account: accountParam,
};

/**
 * Mail rules: list, create, delete. Creating and deleting change what Gmail
 * does to mail that has not arrived yet, so both are logged.
 */
export function registerFilterTools(server: McpServer): void {
  server.tool(
    'list_filters',
    'List the account\'s Gmail filters (mail rules): each filter\'s id, what it matches, and which labels it adds or removes. '
    + 'Read-only. A filter that FORWARDS mail to another address is reported here even though create_filter cannot make one. '
    + SCOPE_NOTE,
    listFiltersParams,
    async ({ account }) => {
      try {
        const result = await listFilters(account ?? undefined);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
      }
    },
  );

  server.tool(
    'create_filter',
    'Create a Gmail filter (mail rule). This changes how FUTURE mail is handled — it does not touch messages already in the mailbox. '
    + 'At least one criterion and at least one label action are required: a filter with no criteria would match everything, and one with no action would do nothing. '
    + 'Adding the "TRASH" label to matching mail is how a filter deletes, and removing "INBOX" is how it archives — say so to the user before creating one. '
    + 'This tool deliberately CANNOT create a forwarding filter; ask the user to set forwarding up in Gmail themselves if that is what they want. '
    + SCOPE_NOTE,
    createFilterParams,
    async ({ from, to, subject, query, negated_query, has_attachment, exclude_chats, add_label_ids, remove_label_ids, account }) => {
      try {
        const result = await createFilter({
          criteria: {
            from: from ?? undefined,
            to: to ?? undefined,
            subject: subject ?? undefined,
            query: query ?? undefined,
            negatedQuery: negated_query ?? undefined,
            hasAttachment: has_attachment ?? undefined,
            excludeChats: exclude_chats ?? undefined,
          },
          addLabelIds: add_label_ids ?? undefined,
          removeLabelIds: remove_label_ids ?? undefined,
          account: account ?? undefined,
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: true, ...result }, null, 2) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
      }
    },
  );

  server.tool(
    'delete_filter',
    'Delete a Gmail filter permanently. Confirm with the user first — there is no undo, and the filter can only be recreated by hand. '
    + 'Deleting a filter does not undo anything it already did to existing mail. '
    + SCOPE_NOTE,
    deleteFilterParams,
    async ({ filter_id, account }) => {
      try {
        const result = await deleteFilter(filter_id, account ?? undefined);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: true, deleted: true, ...result }, null, 2) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
      }
    },
  );
}
