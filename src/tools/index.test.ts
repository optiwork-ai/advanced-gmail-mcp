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
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAllTools } from './index.js';

function roster(): string[] {
  const names: string[] = [];
  const server = { tool: (name: string) => { names.push(name); } };
  registerAllTools(server as never);
  return names;
}

/**
 * The tool list exactly as a client receives it — every parameter shape put
 * through the MCP SDK's real zod-to-JSON-Schema conversion.
 *
 * This exists because of a defect caught on 2026-09-02 that no amount of
 * handler testing could have found. A `z.function()` had been added to one
 * tool's parameters (an injectable timer for a retry loop, which is a perfectly
 * ordinary thing to want). Functions have no JSON Schema, so the conversion
 * THROWS — and the conversion runs over the whole roster at once, so a single
 * such parameter anywhere takes down `tools/list` for all 69 tools. Every unit
 * test passed; the server would have listed nothing.
 */
async function listedTools(): Promise<Array<{ name: string; description?: string; inputSchema: unknown }>> {
  const server = new McpServer({ name: 'roster-test', version: '0.0.0' });
  registerAllTools(server);

  const inner = server.server as unknown as {
    _requestHandlers: Map<string, (req: unknown, extra: unknown) => Promise<{
      tools: Array<{ name: string; description?: string; inputSchema: unknown }>;
    }>>;
  };
  const handler = inner._requestHandlers.get('tools/list');
  if (!handler) throw new Error('the MCP server registered no tools/list handler');
  const response = await handler({ method: 'tools/list', params: {} }, {});
  return response.tools;
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
  // Google Workspace administration (2026-09-02). Every one of these changes
  // the company's directory rather than a mailbox, and two of them cost real
  // money or lock a person out — which is why they are named here one by one.
  'create_group', 'update_group_settings', 'delete_group', 'add_group_alias',
  'add_group_member', 'remove_group_member',
  'create_workspace_user', 'update_workspace_user', 'add_user_alias',
];

const READ_TOOLS = [
  'list_emails', 'search_emails', 'read_email', 'get_thread', 'get_labels',
  'get_history_baseline', 'get_mail_changes', 'get_attachment', 'list_drafts', 'read_draft',
  'list_filters', 'get_vacation',
  'list_chat_spaces', 'list_chat_messages', 'get_chat_message',
  'search_drive_files', 'read_drive_file', 'get_google_doc',
  'list_calendars', 'list_calendar_events', 'get_freebusy',
  'list_workspace_domains', 'list_workspace_users', 'get_workspace_user',
  'list_groups', 'get_group',
];

describe('registerAllTools', () => {
  it('registers 69 tools', () => {
    expect(roster()).toHaveLength(69);
  });

  it('can actually be LISTED — every parameter shape survives JSON Schema', async () => {
    // The listing is the first thing any client asks for. If one tool's schema
    // cannot be converted, the whole call throws and the server appears to
    // offer nothing at all.
    const tools = await listedTools();
    expect(tools).toHaveLength(69);
    expect(tools.map(t => t.name).sort()).toEqual(roster().sort());
    for (const tool of tools) {
      expect(tool.inputSchema, `${tool.name} produced no input schema`).toBeTruthy();
      expect(String(tool.description ?? '').length, `${tool.name} has no description`)
        .toBeGreaterThan(0);
    }
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

  it('registers all fourteen Workspace-admin tools', () => {
    const names = roster();
    for (const name of [
      'list_workspace_domains', 'list_workspace_users', 'get_workspace_user',
      'list_groups', 'get_group',
      'create_group', 'update_group_settings', 'delete_group', 'add_group_alias',
      'add_group_member', 'remove_group_member',
      'create_workspace_user', 'update_workspace_user', 'add_user_alias',
    ]) {
      expect(names).toContain(name);
    }
  });

  it('puts the nine Workspace WRITES on the write side, where they belong', () => {
    // The five reads answer questions. The nine writes change a company's
    // directory: they create addresses that receive mail, delete addresses so
    // that mail bounces, add a paid user seat, and lock a person out of their
    // account. Landing one of those on the read side would be the worst
    // mislabelling in this file.
    for (const name of [
      'create_group', 'update_group_settings', 'delete_group', 'add_group_alias',
      'add_group_member', 'remove_group_member',
      'create_workspace_user', 'update_workspace_user', 'add_user_alias',
    ]) {
      expect(WRITE_TOOLS).toContain(name);
      expect(READ_TOOLS).not.toContain(name);
    }
  });
});
