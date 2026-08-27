---
description: Quick inbox cleanup — archive junk, then triage what matters one at a time
allowed-tools: Task, Read, Glob, Grep, Bash, AskUserQuestion, ToolSearch, mcp__gmail__*
argument-hint: [account] (default: all)
visibility: public
---

# /checkemail — Inbox Cleanup + Triage

Two-phase inbox sweep: (1) batch archive junk, (2) walk through real emails one by one.

**User's input:** $ARGUMENTS

## Setup

Load gmail tools: `ToolSearch` with query `+gmail`.

Determine accounts: if user specified one, use it. Otherwise all configured accounts.

## Phase 1 — Fetch + Classify

1. `list_emails` for each account (max_results=25, parallel). It returns `{messages, nextPageToken}` — classify `messages`; ignore `nextPageToken` unless the user asks to go deeper than one page.
2. For every email with a threadId, check if user already replied:
   - `get_thread` for each thread (parallel, batch by account)
   - If any message in thread has `from:` matching the account's address, mark as **already handled**
3. Classify every inbox email into one of:
   - **Archive** — newsletters, promotions, notifications, social, expired codes, calendar accepts, duplicate sends, FYI-only items user already replied to
   - **Triage** — needs user attention (action required, waiting on reply, unread from a real person, financial/legal)

### Always-archive rules

These are ALWAYS classified as Archive without asking:
- Newsletters / Substacks / daily digests
- Promotional emails (CATEGORY_PROMOTIONS)
- Social notifications (CATEGORY_SOCIAL)
- Calendar accepts/declines (no action needed)
- Automated billing receipts
- GitHub PR merge notifications (already merged = FYI)
- Tool/service update notices
- Threads where user already sent the most recent reply (waiting on other party)

### Present results

Show a single summary with two sections:

**Proposed archives** — grouped table by account:
```
## Proposed Archives (N emails)

### Account-Alias (X)
| From | Subject | Reason |
|------|---------|--------|
```

**Triage queue** — numbered list across all accounts:
```
## Triage Queue (N emails)

| # | Account | From | Subject | Status |
|---|---------|------|---------|--------|
```

Then ask: **"Archive all N? Then we'll walk through triage."**

Wait for user confirmation. User may exclude items from archive or add items to archive.

## Phase 2 — Archive

On approval, `batch_modify` per account (archive action). It returns the IDs that actually succeeded plus a `failures` list — report `modified_count`, and surface any failures rather than reporting a clean sweep.

If user excluded items, move them to triage queue.

## Phase 3 — Triage (one at a time)

For each email in triage queue, in priority order (unread action-needed first, then FYI):

1. Show the email:
   ```
   ### [#1] Account — Sender Name
   **Subject:** Re: Subject line
   **Date:** Wed, Feb 11
   **Status:** Unread
   **Snippet:** "Preview of the email content..."
   ```

2. Ask user what to do via `AskUserQuestion`:
   - **Archive** — done with it
   - **Reply** — draft a reply (show draft for approval before sending)
   - **Unsubscribe** — only offer this when `read_email` shows a non-empty `list_unsubscribe` header. Calls `unsubscribe_email`, then archives the email. Report whether it used mailto or one-click HTTPS, and whether it succeeded.
   - **Skip** — come back to it later
   - (user can always type a custom action)

3. Execute the action. If reply: draft it, show it, wait for approval, then send.

4. Move to next email. Repeat until queue is empty.

When done: **"Inbox clear. N archived, N replied, N skipped."**

## Rules

- Always specify `account` parameter explicitly
- ALWAYS `get_thread` before classifying — never assume no reply was sent based on `read_email` alone
- ALWAYS show reply drafts for approval before sending — never auto-send
- One triage email at a time — wait for user decision before showing next
- Keep summaries concise — sender, subject, date, one-line snippet. Full body only if user asks or if drafting a reply
- Threads where user sent the last message = "waiting on them" → archive by default
- If the triage queue is empty after archives, say so and end
