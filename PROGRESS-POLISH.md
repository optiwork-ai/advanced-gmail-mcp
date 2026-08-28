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
Commit: `8301ad2`

## P2 — an export failure whose body arrived as a string — DONE

G8 moved the Drive export onto `responseType: 'stream'`. gaxios does not parse the body of a
NON-2xx stream answer: it concatenates it onto `response.data` as a plain **string**, and the
thrown Error says only `Request failed with status code N`. So `googleErrorReasons` found no
reasons and `SCOPE_PHRASES` matched nothing — an export 403 came back with no cure in it.

- `src/scope-error.ts` — new private `googleErrorBody(err)` reads Google's `error` object from
  `response.data` whether it is an object OR an unparsed JSON string (a non-JSON body is simply
  not a body — `JSON.parse` failure returns undefined, never throws). `googleErrorReasons` now
  reads through it; new exported `googleErrorMessage(err)` APPENDS Google's own sentence to the
  Error message when the message does not already contain it, so nothing already reported is
  lost and no existing wording changes. `isMissingScopeError` and `scopeError` use it.
- `src/google-api-error.ts` — `translateGoogleApiError`'s `original` is now
  `googleErrorMessage(err)`, so the disabled-API test and the "Original error:" tail both see
  Google's words on a stream call.

Structural, not a patch at the call site: every tool on the honesty path gets this, and the one
place that knows how to read a Google failure stays the one place.

FAIL-before (real, behavioural): 3 failed | 36 passed in `read-only-tools.test.ts`. The fourth
new test (a non-JSON body must not crash the translation) passes on both sides by design — it
is a regression guard, not a demonstration.
PASS-after: 22 files, 752 passed, 0 failed; typecheck clean.
Commit: (recorded below)
