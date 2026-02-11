---
description: Manage email across Gmail accounts via gmail MCP
allowed-tools: Task, Read, Glob, Grep, Bash, Edit, Write, AskUserQuestion, ToolSearch, mcp__gmail__*
argument-hint: [action] [account] [args]
visibility: public
---

# /email - Gmail Management

Manage email across your Gmail accounts using the `gmail` MCP tools.

**User's input:** $ARGUMENTS

## MCP Tools (gmail)

Before using any tool, run `ToolSearch` with query `+gmail` to load them.

| Tool | Purpose |
|------|---------|
| `list_emails` | List inbox/label (account, label, max_results, query) |
| `search_emails` | Gmail query search (query, account, max_results) |
| `read_email` | Read full email by ID (message_id, account) |
| `get_thread` | Get full thread by ID (thread_id, account) |
| `get_labels` | List all labels (account) |
| `send_email` | Send new email (to, subject, body, account) |
| `draft_email` | Create draft (to, subject, body, account) |
| `reply_email` | Reply to email (message_id, body, account) |
| `archive_email` | Archive email (message_id, account) |
| `label_email` | Add/remove labels (message_id, add_labels, remove_labels, account) |
| `trash_email` | Trash email (message_id, account) |
| `batch_modify` | Batch archive/trash/label (message_ids, action, account) |

## Actions

### No args or "triage" → Inbox Triage
1. Ask which account(s) to triage (or default to all)
2. For each account, `list_emails` with max_results=25
3. Summarize inbox: group by sender/category, flag urgent items
4. Ask user what to archive/trash/reply to
5. Execute batch actions

### "cleanup" → Daily Email Triage (full workflow)
**Phase 1 — Cleanup:** Search all accounts for promotions, newsletters, notifications, social, cold outreach. Present grouped summary. Batch archive on approval.
**Phase 2 — Triage:** List remaining inbox per account. Categorize: urgent / action needed / FYI / quick decisions. Present summary tables.
**Phase 3 — Walkthrough:** Read full content of urgent/action items. Brief user with context + recommended action. Group quick decisions separately.
**Phase 4 — Decisions:** Walk through quick decisions one at a time. Wait for user response before next. For each: archive, reply (draft first, get approval), or forward.

### "search {query}" → Search
1. Search across specified or all accounts
2. Present results

### "send" / "draft" / "reply" → Compose
1. Use write tools as directed
2. Always confirm before sending (drafts don't need confirmation)

### "labels" → Show Labels
1. `get_labels` for specified account

## Rules

- Always specify `account` parameter explicitly — never rely on default
- For triage: present a summary table first, then ask for actions — don't auto-archive
- For batch operations: always confirm with user before executing
- When reading emails, show sender, subject, date, and snippet — not full bodies unless asked
- **ALWAYS check full thread** (`get_thread`) before telling the user an action hasn't been taken. `read_email` returns a single message — the user's reply may be a different message in the same thread
- **ALWAYS review email drafts with user before sending** — never auto-send replies. Show the draft and wait for approval or edits
