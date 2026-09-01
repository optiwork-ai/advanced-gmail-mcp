/**
 * The roster — what this server actually offers, and which half of it writes.
 *
 * There was no such test before 2026-09-01: the tool count lived in the README
 * and in commit messages, which is to say nowhere the build could check. A tool
 * added to `src/tools/` but never wired into `registerAllTools` is invisible at
 * runtime and completely silent at test time, and a WRITE tool that nobody
 * listed as one is worse than invisible.
 *
 * Registration is pure — `server.tool(...)` with a zod schema and a closure — so
 * this needs no network, no token and no mock beyond a server that writes down
 * what it was handed.
 */
import { describe, expect, it } from 'vitest';
import { registerAllTools } from './index.js';

function roster(): string[] {
  const names: string[] = [];
  const server = { tool: (name: string) => { names.push(name); } };
  registerAllTools(server as never);
  return names;
}

/**
 * Every tool that changes something a person could later look at: a mailbox, a
 * Drive file, a document, a calendar, a Chat space, a spreadsheet. The split is
 * the point of the list — a new write tool has to be named here deliberately.
 */
const WRITE_TOOLS = [
  // Gmail — outbound and mailbox state
  'send_email', 'draft_email', 'reply_email', 'draft_reply', 'send_draft', 'forward_email',
  'update_draft', 'delete_draft',
  'archive_email', 'label_email', 'trash_email', 'modify_thread', 'trash_thread',
  'batch_modify', 'unsubscribe_email', 'mark_read', 'mark_unread', 'star_email',
  'unstar_email', 'mark_important', 'mark_not_important',
  'create_label', 'update_label', 'delete_label',
  'create_filter', 'delete_filter', 'set_vacation',
  // Chat, Drive, Docs, Calendar
  'post_chat_message',
  'upload_drive_file',
  'create_google_doc', 'update_google_doc',
  'create_calendar_event',
  // Sheets (2026-09-01)
  'update_sheet_values', 'append_sheet_rows',
];

const READ_TOOLS = [
  'list_emails', 'search_emails', 'read_email', 'get_thread', 'get_labels',
  'get_history_baseline', 'get_mail_changes', 'get_attachment', 'list_drafts', 'read_draft',
  'list_filters', 'get_vacation',
  'list_chat_spaces', 'list_chat_messages', 'get_chat_message',
  'search_drive_files', 'read_drive_file', 'get_google_doc',
  'list_calendars', 'list_calendar_events', 'get_freebusy',
];

describe('registerAllTools', () => {
  it('registers 55 tools', () => {
    expect(roster()).toHaveLength(55);
  });

  it('registers each name exactly once', () => {
    const names = roster();
    expect(new Set(names).size).toBe(names.length);
  });

  it('is exactly the read side plus the write side — nothing unaccounted for', () => {
    expect(roster().sort()).toEqual([...READ_TOOLS, ...WRITE_TOOLS].sort());
  });

  it('puts the two Sheets tools on the WRITE side, where they belong', () => {
    expect(WRITE_TOOLS).toContain('update_sheet_values');
    expect(WRITE_TOOLS).toContain('append_sheet_rows');
    expect(READ_TOOLS).not.toContain('update_sheet_values');
    expect(READ_TOOLS).not.toContain('append_sheet_rows');
  });

  it('actually registers both of them', () => {
    const names = roster();
    expect(names).toContain('update_sheet_values');
    expect(names).toContain('append_sheet_rows');
  });
});
