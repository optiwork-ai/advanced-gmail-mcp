# ROUND 2 — Builder A (gmail repo) progress

Contract: `shared/active-work/2026-08-27-gmail-mcp-upgrade/BUILD-CONTRACT-ROUND2.md` (FROZEN).
Evidence pack: `round2-sweep-evidence.json` (normative for unit scope).

## Environment / concurrency notes

- **Baseline sha (read fresh, `git log -1 main` at start): `a513a81089f46e6c5c8d1b1d383f3c657d8f7609`**
  — "docs(progress): record the docs commit sha".
- Branch `feat/round2-enhancements`, created off `main` at that sha.
- **Isolated worktree** (the live checkout was never touched — it serves the running MCP
  server to other sessions):
  `/private/tmp/claude-501/-Users-steve-Claude-Projects-2-backbone-advanced-gmail-mcp/103223c4-7676-4d7d-9a3d-198956ea26d8/scratchpad/wt-gmail-round2`
- Live checkout state at start: **clean**, on `main` at the baseline sha. Nothing odd.
- `node_modules` was absent in the fresh worktree. Ran `npm install --no-audit --no-fund`
  inside the worktree (167 packages). It rewrote two lines of `package-lock.json`
  (registry metadata); that change was reverted with `git checkout package-lock.json`
  so the lockfile stays exactly as committed. No `NODE_PATH` hack was needed.

## BASELINE SUITE (untouched worktree, before any edit)

- `npm test` → **13 files, 578 passed, 0 failed. GREEN.**
- `npm run typecheck` → **clean, exit 0.**
- Gate for this build is therefore the strict one: **578 + new tests, all green,
  zero failures.**

## Units

### G1 — unsubscribe confirm gate + honest benign case + delete_label enforcement — DONE
- Commit: `9590c9f`
- FAIL-before: `npx vitest run src/gmail/api.test.ts` → **6 failed | 119 passed (125)**
  before the implementation (the six new gate/benign assertions).
- PASS-after: full suite **587 passed (587)**, typecheck clean.
- What changed:
  - `unsubscribeFromEmail` takes `confirm?: boolean`. The **mailto fallback**, which is a
    real outbound send from the owner's account, is refused without `confirm: true`; the
    refusal names the recipient, subject and body it would have sent, and carries any
    prior HTTPS failures. The **one-click HTTPS path is deliberately NOT gated** — it puts
    no mail in anyone's mailbox and is the path that should be preferred.
  - An email with **no `List-Unsubscribe` header now returns `success: true`** with
    "nothing to unsubscribe from". It was reported as a failure, so Claude retried and
    apologised for a normal outcome. A header it cannot parse is still a failure.
  - `deleteLabel` enforces the confirmation its tool description has always stated:
    `confirm: true` or the call throws, **before** the log line and before the API call
    (mirrors the vacation guard, 25bac29).
  - Tool schemas + descriptions for `unsubscribe_email` and `delete_label` state the rules;
    README rows updated.
- **Restated, not loosened:** two pre-existing call sites gained an argument because the
  contract changed — `deleteLabel({ labelId: 'L1' })` → `+ confirm: true`, and the
  "falls back to the mailto unsubscribe" test → `+ confirm: true`. No assertion in either
  test was changed or removed.
