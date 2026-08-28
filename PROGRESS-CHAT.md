# Chat posting round — progress

Branch `feat/chat-posting` off `main` @ e0bf9b1 (v1.7.1, 52 tools).
Worktree: `/Users/steve/Claude-Projects/2-backbone/advanced-gmail-mcp-wt/chat-post`.
Baseline before any change: **772 tests green, typecheck clean**.

Context: Steve reversed the 2026-08-27 read-only-Chat ruling on 2026-08-28
("lets get chat posting working as well"). This round adds ONE tool,
`post_chat_message`, and ONE scope, `chat.messages.create`.

## Units

- [ ] CP1 — `chat.messages.create` in SCOPES; scope constant exported; honest
      scope error through the `googleApiCall` path.
- [ ] CP2 — `post_chat_message` tool (roster 52 → 53), registered in index.ts.
- [ ] CP3 — README (roster 53, tool row, scope bullet, read-only posture ended),
      CHANGELOG 1.8.0, package.json 1.8.0.

## Log

(filled in as units land)
