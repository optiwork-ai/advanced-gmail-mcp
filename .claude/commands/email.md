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
| `list_emails` | List inbox/label (account, label, max_results, query, page_token) — returns `{messages, nextPageToken}`; label and query are ANDed |
| `search_emails` | Gmail query search across the mailbox (query, account, max_results, page_token) — returns `{messages, nextPageToken}` |
| `read_email` | Read full email by ID (message_id, account) |
| `get_thread` | Get full thread by ID (thread_id, account) |
| `get_labels` | List all labels (account, include_counts?) |
| `get_history_baseline` | Current mailbox change cursor (account) — store the `historyId` yourself |
| `get_mail_changes` | What changed since a cursor (history_id, account, history_types?, label_id?, max_results?, page_token?, include_summaries?) — only store the returned `historyId` when `complete` is true |
| `send_email` | Send new email (to, subject, body, account, attachments?, inline_images?) — `inline_images` needs `is_html: true` and `<img src="cid:FILENAME">` |
| `draft_email` | Create draft (to, subject, body, account, attachments?, inline_images?) |
| `reply_email` | Reply to email (message_id, body, account, attachments?, inline_images?) |
| `draft_reply` | Draft a reply (review in Gmail before sending) |
| `send_draft` | Send an existing draft by ID |
| `archive_email` | Archive email (message_id, account) |
| `label_email` | Add/remove labels (message_id, add_labels, remove_labels, account) |
| `trash_email` | Trash one message (message_id, account) |
| `modify_thread` | Add/remove labels across a whole thread (thread_id, add_labels, remove_labels, account) — archive = remove `INBOX` |
| `trash_thread` | Trash an entire thread (thread_id, account) — confirm with user first |
| `batch_modify` | Batch archive/trash/label (message_ids, action, account) — returns the IDs that actually succeeded plus any failures |
| `unsubscribe_email` | Process `List-Unsubscribe` header (one-click HTTPS or mailto) |
| `mark_read` | Remove UNREAD label (message_id, account) |
| `mark_unread` | Add UNREAD label (message_id, account) |
| `get_attachment` | Fetch an attachment, embedded body images included (message_id, attachment_id, account, save_dir?) — pass `save_dir` to write it to disk; inline base64 is capped at 1MB |
| `list_drafts` | List drafts with id + headers (account, max_results, page_token) — returns `{drafts, nextPageToken}` |
| `read_draft` | Read a draft's content by ID (draft_id, account) |
| `update_draft` | Replace a draft's contents (draft_id + the same params as `draft_email`) — Gmail REPLACES, so resend every field |
| `delete_draft` | Permanently delete a draft (draft_id, account) — confirm with user first |
| `forward_email` | Forward an email (message_id, to, account, body?, cc?, bcc?, is_html?) |
| `star_email` / `unstar_email` | Toggle STARRED label (message_id, account) |
| `mark_important` / `mark_not_important` | Toggle IMPORTANT label (message_id, account) |
| `create_label` | Create a label (name, text_color?, background_color?, account) |
| `update_label` | Rename/recolor a label (label_id, name?, colors?, account) |
| `delete_label` | Delete a label (label_id, account) — confirm with user first |
| `list_filters` | List the account's mail rules (account) — read-only |
| `create_filter` | Create a mail rule (from?, to?, subject?, query?, negated_query?, has_attachment?, exclude_chats?, add_label_ids?, remove_label_ids?, account) — future mail only; `TRASH` deletes, removing `INBOX` archives; cannot forward |
| `delete_filter` | Delete a mail rule permanently (filter_id, account) — confirm with user first |
| `get_vacation` | Read the vacation-responder settings (account) — read-only |
| `set_vacation` | Turn the vacation responder on/off (enable, confirm?, subject?, body?, is_html?, start_time?, end_time?, restrict_to_contacts?, restrict_to_domain?, account) — while ON the account auto-replies to everyone. `enable: true` REQUIRES `confirm: true` and is refused when the saved window already ended; `enable: false` needs neither |
| `upload_drive_file` | Upload a local file to Drive (file_path absolute, folder_id?, name?, convert?, account) — always creates a NEW file; 100MB cap. `convert: true` lands it as a real Google Sheet/Doc/Slides (xlsx, xls, ods, csv, tsv / docx, doc, odt, rtf, txt / pptx, ppt, odp); any other type is refused before uploading |
| `update_sheet_values` | Overwrite a range of a Google Sheet (spreadsheet_id, range in A1 notation, values, value_input_option?, account) — only works on spreadsheets this server created (upload with `convert: true` first); max 1,000 rows / 10,000 cells |
| `append_sheet_rows` | Add rows to the end of a table (spreadsheet_id, range as an anchor like `Sheet1`, values, value_input_option?, account) — inserts rather than overwriting; same creator limit and same caps; NOT retried on a server error |

> The five settings tools and `upload_drive_file` need scopes added on 2026-08-27 (`gmail.settings.basic`, `drive.file`). An account authenticated before then answers **403** until it re-runs `npm run auth -- <alias>`; the error message says so.
>
> The two Sheets tools need **no** new scope — they ride the same `drive.file` grant, which is why they reach only spreadsheets this server created. They do need the **Google Sheets API enabled** on the Cloud project; the first write says so and names the console page if it is not.

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
