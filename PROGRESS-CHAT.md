# Chat posting round — progress

Branch `feat/chat-posting` off `main` @ e0bf9b1 (v1.7.1, 52 tools).
Worktree: `/Users/steve/Claude-Projects/2-backbone/advanced-gmail-mcp-wt/chat-post`.
Baseline before any change: **772 tests green, typecheck clean**.
After the round: **808 tests green, typecheck clean, 53 tools, v1.8.0**.

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

## Fix pass — the four confirmed review findings (2026-08-28)

Baseline entering the pass: **808 tests green, typecheck clean**. After it:
**829 tests green, typecheck clean**. One commit per finding, FAIL-before
demonstrated for each.

- [x] **CP-1** — `<users/all>` quoted out of an email no longer pages the whole
      space. Chat's `text` is not inert (Google: "You can also @mention a Google
      Chat user, or everyone in the space") and the parameter description said
      the opposite. Mention markup is now defused before posting (angle brackets
      dropped, so it reads as "users/all"), `allow_mentions: true` sends it as
      written, and the result carries `mentionsDefused` plus a note.
      808 → 816. FAIL-before: 6 tests.
- [x] **CP-2** — every post carries Chat's idempotency key (`requestId`, a UUID
      or the caller's `request_id`), and a failure that could have landed (5xx or
      no status) says the message may already be in the named space and gives the
      key to retry under. A 4xx refusal is left untouched. The raw status is
      captured at the call site because the honest-error translation drops the
      numeric code on purpose. 816 → 820. FAIL-before: 3 tests.
- [x] **CP-3** — the `thread_key` note no longer asserts that later posts join
      this thread. Google documents a thread key as unique to the Chat APP that
      sets it; this server posts as a user, and the fallback option means a
      failure to thread is SILENT. The note now reports the landed thread, says
      joining is unconfirmed, and points at passing `thread` instead. Parameter
      description, tool description, README and CHANGELOG corrected to match.
      820 → 822. FAIL-before: 2 tests.
- [x] **CP-4** — space, thread and message ids are validated before the client is
      built. They land in path parameters expanded by reserved URI-template
      expansion, which does not encode "/", "?", ":" or "#", so an unchecked id
      re-targeted the request instead of being refused. 822 → 829.
      FAIL-before: 6 tests.

**Design fork raised, not improvised:** CP-Q1 in
`shared/active-work/2026-08-27-gmail-mcp-upgrade/QUESTIONS-FOR-FABLE.md` — now
that `requestId` is sent, should the post's retries go back on? It cannot be
settled with mocks; it needs one live experiment (post twice with the same
`request_id`, see whether one message appears or two). Retries stay OFF until
the chair rules.

## What the chair still has to do

1. **Consent round #2 — all five aliases.** `chat.messages.create` is a NEW scope,
   so every existing token lacks it and `post_chat_message` 403s (honestly, naming
   the scope) until each alias re-runs:
   `npm run auth -- personal`, `steve-ah`, `info-ah`, `steve-optiwork`, `steve-hub`
2. **Live `[TEST]` post** into a space Steve names. Nothing in this round posted to
   any real space — every test is mocked. Three things worth checking while the
   live window is open, all cheap:
   - post twice with the same `request_id` — one message or two? (settles CP-Q1)
   - post twice with the same `thread_key` — one conversation or two? (settles the
     honesty added in CP-3, and tells the chair whether to keep the parameter)
   - post once with `allow_mentions: true` and a mention of yourself, to confirm
     the opt-in path still notifies.

## Design notes (for the reviewer / validator)

- **No confirm parameter** — chair's design ruling, not the builder's choice:
  automated alerting from scheduled sessions is the use case, posts are attributed
  and deletable, and this mirrors `send_email`. The honesty lives in the tool
  description's first sentence instead.
- **The post is not retried at all (CP2b).** The shared `googleApiCall` retries
  500/502/503/504, and a gateway failure can arrive AFTER Chat accepted the
  message — retrying would say the same thing twice in front of the space and
  return the id of only one. `googleApiCall` gained a pass-through `maxRetries`
  and the post uses 0; the two reads around it keep their retries.
  FAIL-before demonstrated: with the pass-through removed, the 503 test sees the
  post issued 4 times.
- **Display name is fetched AFTER the post**, best-effort and silent on failure, so
  a missing `chat.spaces.readonly` can never make a posted message look failed.
- **A thread in another space is refused**, not silently re-pointed at the space
  being posted to.
