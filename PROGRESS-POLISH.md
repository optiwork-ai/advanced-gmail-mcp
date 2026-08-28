# Round 2 polish pass — progress

Worktree: `/Users/steve/Claude-Projects/2-backbone/advanced-gmail-mcp-wt/polish`
Branch: `feat/round2-polish`, off `main` @ `3e2a011`.
Baseline gate (untouched worktree): `npm test` = 22 files, **746 passed, 0 failed**;
`npm run typecheck` clean, exit 0. Disk at start: 4.3Gi free on `/`.
`npm install --no-audit --no-fund` touched 2 lines of `package-lock.json`; reverted, lockfile
is byte-identical to the committed one.

Prohibitions honoured throughout: no push, no deploy, no live Google call (every test mocks
the API), no credentials/IAM/DNS, no AI attribution, nothing spawned. The live checkout
`/Users/steve/Claude-Projects/2-backbone/advanced-gmail-mcp` was never touched.

## P1 — `resumedFrom` carries the real remembered cursor — DONE

The field was set to the literal sentence `'the remembered cursor'`. A field named for a
cursor now carries the cursor: the value read out of the store (`remembered`), which a caller
can log, compare, or poll with. It equals `fromHistoryId` — that is the point: it says the
server remembered this position rather than the caller sending it.

- `src/gmail/client.ts` — `resumedFrom: remembered` in place of the sentence.
- `src/gmail/types.ts` — `MailChanges.resumedFrom` doc rewritten to state what the value IS
  and when it is present.
- `src/tools/mail-changes.ts` — `resumedFrom` added to the description's `Returns { ... }`
  list (it was omitted entirely) plus one sentence explaining it.
- Tests: 2 new in `src/gmail/api.test.ts` (value is the remembered id; absent when the caller
  supplied a cursor).

FAIL-before (real, behavioural): 1 failed | 141 passed —
`expected 'the remembered cursor' to be '4200'`.
PASS-after: 22 files, 748 passed, 0 failed; typecheck clean.
Commit: (recorded below)
