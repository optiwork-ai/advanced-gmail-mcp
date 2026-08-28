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
Commit: `c88bf1e`

## P3 — upload_drive_file joins the shared honesty path — DONE

`uploadFile` was the last Drive/Docs call on `withScopeHint(ctx, () => withRetry(...))`.
`withScopeHint` rescues only a MISSING SCOPE; every other 403 fell through to `withRetry`'s
rewrite — "Authentication error (403) … Re-authenticate with: npx tsx src/auth.ts" — and
Drive's other 403s (a folder this account cannot write to, the Drive API switched off on the
project, a storage quota) are none of them a broken login.

**Retry behaviour preserved, verified by reading both helpers.** `googleApiCall` IS
`withRetry` with the translation inside it (`src/google-api-error.ts`), so nothing had to be
composed: the read stream is still created per attempt inside the retry loop, a 5xx is still
retried, and a rate-limit 403 is still returned untouched so `withRetry` backs off on it. A
test pins the fresh-stream-per-attempt behaviour on the new path, alongside the pre-existing
one that already pinned it on the old.

One improvement falls out of the ordering: the translation now runs INSIDE the retry, on the
raw Google error, instead of after `withRetry` had already rewritten it.

- `src/drive/client.ts` — `googleApiCall` with `api: 'Google Drive'`; the now-unused
  `withRetry` / `withScopeHint` imports dropped. `withScopeHint` itself is untouched and
  still exported and tested.
- Tests: 4 new in `src/drive/client.test.ts` (per-file 403, disabled API, retry preserved,
  401 still routed to re-authenticate).

FAIL-before (real, behavioural): 2 failed | 23 passed. The retry and 401 tests pass on both
sides by design — they are the regression guards that prove nothing was dropped.
PASS-after: 22 files, 756 passed, 0 failed; typecheck clean.
Commit: `393becf`

## P4 — a deleted or edited Chat message says so — DONE

G4's projection dropped `deletionMetadata` and `lastUpdateTime` along with the genuine noise,
so a DELETED message and an EDITED one came back looking exactly like an ordinary one. A
reader summarising a space could quote a message the author had retracted, or an old wording
as though it were current, with nothing in the answer to warn them.

- `src/tools/chat-list-messages.ts` — `projectChatMessage` emits `deleted: true` (plus
  `deleteTime` and `deletedBy` when Chat reports them) and `edited: true` + `lastUpdateTime`.
  Both absent on an ordinary message, so their presence means something.
- Description updated: names both markers, says an edited message's `text` is the CURRENT
  wording, and says not to quote a deleted message as though it stands.

Beyond the literal ask, flagged and one-line reversible: `deleteTime` and `deletedBy`
(`deletionMetadata.deletionType`) are carried too. `deletionType` is the whole content of
`deletionMetadata` and it distinguishes "the author retracted this" from "an admin removed
it"; dropping it would have meant reading the object and throwing away the only thing in it.

FAIL-before (real, behavioural): 3 failed | 40 passed. The fourth new test (an ordinary
message carries neither marker) passes on both sides by design — it is the guard that keeps
the markers meaningful.
PASS-after: 22 files, 760 passed, 0 failed; typecheck clean.
Commit: `d3bf6ab`

## P5 — the watcher's bookmark belongs to an account AND a filter — DONE

`get_mail_changes` takes `label_id` and `history_types`, and a poll only ever sees the
changes its filter admits — but the bookmark was keyed on the alias alone. An INBOX-only
agent and an unfiltered watcher on one account therefore shared a cursor and silently ate
each other's window: whichever polled first moved it past everything, and the other was told
nothing had happened. Neither could tell.

- `src/gmail/cursor-store.ts` — new exported `CursorFilter { labelId?, historyTypes? }`;
  `readCursor` / `writeCursor` / `cursorFilePath` all take it.
  - **Unfiltered keeps today's filename exactly** (`<alias>.json`), so
    `cursors/steve-optiwork.json` keeps working and no watcher restarts blind. An EMPTY
    filter is the unfiltered case.
  - **Filtered gets `<alias>--<16 hex>.json`.** The digest is sha256 over the UNSANITIZED
    alias + the canonical filter, so it is collision-free in both directions: two filters on
    one account cannot share a file, and neither can two aliases that sanitize to the same
    name (`a/b` and `a_b` — the G12 alias-collision advisory, closed for filtered files).
  - Signature is order-independent (`historyTypes` sorted), so the same filter written two
    ways is one bookmark. An explicit list of all four types is still a filter: the signature
    records what the caller asked for.
  - The rewind rule is per filter — one filter's position says nothing about another's.
  - The file body records the filter for diagnosability; it is never read back (the filename
    identifies the file), so an old file without it still loads.
- `src/gmail/client.ts` — builds the filter from `opts.labelId` / `opts.historyTypes` and
  passes it to all three calls, including the `cursorFilePath` named in the wedged-cursor
  cure. Explicit `history_id` still bypasses the store entirely and wins.
- Descriptions: the tool description and `getMailChanges`'s doc say the position is per
  account AND per filter and to poll with the same filter each time; README updated in two
  places.

FAIL-before (real, behavioural, two levels):
- store: 6 failed | 15 passed in `cursor-store.test.ts`;
- client: 4 failed | 141 passed in `api.test.ts`, demonstrated by restoring the committed
  `client.ts` under the new tests and running them.

**One pre-existing test call site restated, no assertion weakened:**
`expect(cursorStore.writeCursor).toHaveBeenCalledWith('work', '5000')` gained the third
argument `{}` — the callee's contract changed. The `cursorStore` stub in `api.test.ts` was
widened to key by alias + filter, mirroring the real store; that is a harness change, not a
loosened assertion.

PASS-after: 22 files, 772 passed, 0 failed; typecheck clean.
Commit: (recorded below)
