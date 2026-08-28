# Chat posting round — progress

Branch `feat/chat-posting` off `main` @ e0bf9b1 (v1.7.1, 52 tools).
Worktree: `/Users/steve/Claude-Projects/2-backbone/advanced-gmail-mcp-wt/chat-post`.
Baseline before any change: **772 tests green, typecheck clean**.
After the round: **807 tests green, typecheck clean, 53 tools, v1.8.0**.

Context: Steve reversed the 2026-08-27 read-only-Chat ruling on 2026-08-28
("lets get chat posting working as well"). This round adds ONE tool,
`post_chat_message`, and ONE scope, `chat.messages.create`.

## Units

- [x] **CP1** — `chat.messages.create` added to SCOPES; `CHAT_MESSAGES_CREATE_SCOPE`
      exported from `src/chat/client.ts`; the two read-only Chat scopes kept
      (create does not include read). `SCOPES` is now exported so the consent URL
      itself is testable. 772 → 776 tests.
      FAIL-before: all 4 of `src/gmail/auth-scopes.test.ts` fail at HEAD (SCOPES
      not exported, scope absent, constant absent).
- [x] **CP2** — `post_chat_message` (roster 52 → 53), registered in
      `src/tools/index.ts`; `toThreadTarget` added to `src/chat/names.ts`.
      776 → 807 tests (25 tool + 6 names).
      FAIL-before: `src/tools/chat-post-message.ts` does not exist at HEAD
      (`git show HEAD:src/tools/chat-post-message.ts` → "exists on disk, but not
      in 'HEAD'"), so every tool test fails to resolve the module.
- [x] **CP3** — README (roster 53, tool row, `chat.messages.create` bullet with the
      consent round, read-only posture ended 2026-08-28 by owner ruling);
      CHANGELOG 1.8.0 in plain language; `package.json` → 1.8.0.

## What the chair still has to do

1. **Consent round #2 — all five aliases.** `chat.messages.create` is a NEW scope,
   so every existing token lacks it and `post_chat_message` 403s (honestly, naming
   the scope) until each alias re-runs:
   `npm run auth -- personal`, `steve-ah`, `info-ah`, `steve-optiwork`, `steve-hub`
2. **Live `[TEST]` post** into a space Steve names. Nothing in this round posted to
   any real space — every test is mocked.

## Design notes (for the reviewer / validator)

- **No confirm parameter** — chair's design ruling, not the builder's choice:
  automated alerting from scheduled sessions is the use case, posts are attributed
  and deletable, and this mirrors `send_email`. The honesty lives in the tool
  description's first sentence instead.
- **Not retried on an ambiguous failure.** `googleApiCall` retries only rate-limit
  and transient failures; a post that landed is never re-issued.
- **Display name is fetched AFTER the post**, best-effort and silent on failure, so
  a missing `chat.spaces.readonly` can never make a posted message look failed.
- **A thread in another space is refused**, not silently re-pointed at the space
  being posted to.
