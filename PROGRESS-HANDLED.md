# Handled by Claude — builder progress (Contract C)

Contract: `/Users/steve/Claude-Projects/shared/active-work/2026-11-03-persona-inbox-organizing/40-CONTRACT-C-handled-by-claude.md` (FROZEN 11/03/2026 1:43 PM ET).
Branch `feat/handled-by-claude`, worktree `/Users/steve/Claude-Projects/2-backbone/advanced-gmail-mcp-handled-wt`.
Base: `19bc657cdff6df2a2311c9bfd95d98a5b9a89d9c` (main, clean). The live checkout was never touched.

## Baseline (untouched worktree)
- `npm test`: 31 files, 1143 passed. `npm run typecheck`: clean.
- `node_modules` installed in the worktree with `npm install`; `package-lock.json` reverted to the committed copy.

## Units
- DONE `391f8b6` — shared helper, three send paths, `mark_handled` tool, tests.
  - Fails before (tests written first, `src/gmail/handled.test.ts` + roster pin in `src/tools/index.test.ts`): 15 failed, 9 passed (the 9 are the "nothing changes" assertions and untouched roster checks).
  - Passes after: those two files 24/24; full suite 32 files, 1159 passed; typecheck clean.
- DONE (docs commit) — README tool rows + count 70, CHANGELOG `[Unreleased]`, this file.

## New lasting parts and the requirement each serves
- `fileThreadHandled` (client.ts): Steve's rule (read, out of the inbox, "Handled by Claude") must be one operation that behaves the same in every account; nothing existing combines find-or-create label with a thread modify.
- `fileAfterSend` (client.ts): a cleanup failure after a delivered send must be reported and logged, never thrown (a thrown error invites a resend) and never swallowed.
- `markHandled` + `mark_handled` tool: a session that finishes an email without replying needs one call to file it.
- `SendResult.cleanup` field: the session must see whether the filing worked.
- `HANDLED_LABEL_NAME` constant and `FILES_HANDLED_CLAUSE` description text: one spelling of the label, and one sentence telling sessions what the three send tools now do.
- The Gmail label "Handled by Claude" itself (created on first use per account): the destination Steve chose.
- Removed: NONE. Reused: `listLabels`, `createLabel`, `modifyThread` (audited log lines), `getMessage`, `withRetry`.

## Decisions inside the contract
- send_draft tells a reply from a brand-new message by reading the sent message's thread (format minimal): more than one message means it answered a conversation. One extra read per send_draft.
- No label-id cache: one `labels.list` per filing keeps a deleted or renamed label from leaving a stale id.
- Label match is case-insensitive (Gmail treats label names that way), so an existing "handled by claude" is reused, never duplicated.

## Scope check (documented scope sets, tokens not read)
Every account in accounts.json (personal, steve-ah, info-ah, steve-optiwork, steve-hub, pmcc-admin, pmcc-matt, pmcc-lidia, pmcc-info, pmcc-lucia, hub-orders) is asked for the shared `SCOPES` list (`src/gmail/auth.ts:54`), which includes `gmail.modify` (`:56`); admin accounts get that list plus `ADMIN_SCOPES` (`scopesFor`, `:130`). No account's documented set lacks it. What each token actually granted was not checked (tokens are off-limits); `npm run auth:check` in the live checkout shows it.

## Scans (range 19bc657..tip)
- gitleaks: no leaks. semgrep p/typescript + p/javascript on the 9 changed source files: 0 findings, 0 errors.
- osv-scanner: 96 known vulnerabilities in 22 packages, all pre-existing; `package.json` and `package-lock.json` are unchanged in the range.

## Remaining
- Independent check (cold-checker), then Steve's go to merge and restart the live server; then the real-boundary test (reply to a test message in one account, read the labels back).
