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

### G2 — image attachments returned as MCP image content blocks — DONE
- Commit: `5e3f867`
- FAIL-before: `npx vitest run src/tools/get-attachment.test.ts` → **10 failed (10)**
  (the module exported neither `attachmentContentBlocks` nor `isViewableImage`).
- PASS-after: full suite **597 passed (597)**, 14 files, typecheck clean.
- What changed: new pure `attachmentContentBlocks(result)` in `src/tools/get-attachment.ts`
  decides the content array; the handler just calls it.
  - A PNG/JPEG/GIF/WebP fetched **without** `save_dir` now returns a real
    `{ type: 'image' }` block, so the model can see the picture.
  - The JSON metadata block is kept alongside it, minus `data_base64` (the bytes are
    already in the image block; repeating them would double the cost of every image
    read) and plus a `returned_as` line saying where they went.
  - Deliberate **whitelist**, not `image/*`: SVG is a script vector and TIFF/HEIC are not
    required to render, so those keep the old base64 behaviour rather than risking the
    whole tool call being rejected. Mime type is matched case-insensitively and with
    parameters stripped (`image/jpeg; name="scan.jpg"`).
  - Size cap honored twice: `getAttachment` still refuses >1MB inline, and the block
    builder independently refuses to build an image block above the cap.
  - `save_dir` reads are unchanged (bytes went to disk; no image block is fabricated),
    and non-image attachments are byte-for-byte the same response as before.

### G3 — scope-error honesty extended to the four read-only tools — DONE
- Commit: `ee5f2b6`
- FAIL-before: `npx vitest run src/tools/read-only-tools.test.ts` → **12 failed | 4 passed
  (16)**. The four that passed are the 401 pass-throughs, which were already correct.
- PASS-after: full suite **613 passed (613)**, 15 files, typecheck clean. The 49 existing
  Calendar tests stayed green through the refactor below, unmodified.
- **Structural choice (worth the reviewer's attention):** rather than copy
  `translateCalendarError` into four more tools, its body was lifted into a new shared
  module `src/google-api-error.ts` (`translateGoogleApiError` + `googleApiCall`), with the
  service's human name as one more context field. `translateCalendarError` is now a
  one-line delegation that fixes `api: 'Google Calendar'`, so its call sites and its tests
  are untouched and no call site can mislabel the API. Layering is
  `google-api-error.ts → gmail/client.ts → scope-error.ts`; `scope-error.ts` still imports
  nothing, so no cycle was introduced.
- The four tools (`list_chat_spaces`, `list_chat_messages`, `search_drive_files`,
  `get_google_doc`) now run their API calls through `googleApiCall` with a context naming
  the tool, the API and the scope that call actually needs. New exported scope constants:
  `CHAT_SPACES_SCOPE`, `CHAT_MESSAGES_SCOPE` (chat/client.ts), `DRIVE_READONLY_SCOPE`
  (drive/client.ts), `DOCS_READONLY_SCOPE` (docs/client.ts) — matching the existing
  `DRIVE_FILE_SCOPE`/`CALENDAR_*_SCOPE` idiom.
- Behaviour per tool: missing scope → names the scope + `npm run auth -- <alias>`;
  disabled API → says to enable it in the Cloud console and that re-authenticating will not
  help; any other 403 → restated with Google's own words and no re-auth advice; rate-limit
  403 → untouched so `withRetry` still retries it; **401 → untouched**, because there
  re-authenticating really is the fix.

### G4 — Chat list field projection — DONE
- Commit: `30bb921`
- FAIL-before: 4 of the 8 new projection assertions failed (`23 tests: 4 failed | 19
  passed`) — the four that already passed were the "absent field" and spaces-description
  cases, which were accidentally correct.
- PASS-after: full suite **620 passed (620)**, typecheck clean.
- `projectSpace` (chat-list-spaces.ts) returns exactly the four fields the description has
  always promised — name, displayName, spaceType, spaceDetails — and omits an absent field
  rather than emitting `null` for it (a `null` asserts "this space has no display name"
  when the truth is Google did not send one).
- `projectChatMessage` (chat-list-messages.ts) returns name, sender {name, displayName,
  type}, createTime, text and thread. It drops the space object repeated in full on every
  message, annotations, card payloads, reaction summaries and the three duplicate copies
  of the text.
- **Two deliberate keeps, against data loss:** `attachments` reduced to
  {contentName, contentType} — dropping them would make "here's the report" look like a
  message with nothing attached, a silent lie rather than a saving; and `fallbackText`
  **only when `text` is empty**, so a card-only build/alert message does not read as an
  empty message from a bot.
- Both tool descriptions now state exactly what they return (the messages one previously
  said "the raw Chat message objects"); README rows updated.

### G5 — shared-drive visibility on Drive search — DONE
- Commit: `d8fa7e0`
- FAIL-before: `4 failed | 23 passed (27)` in read-only-tools.test.ts.
- PASS-after: full suite **624 passed (624)**, typecheck clean.
- `files.list` now sends the **three flags Google requires together**: `supportsAllDrives:
  true`, `includeItemsFromAllDrives`, and `corpora`. The third is the one that is easy to
  miss — with only the first two, Drive still defaults `corpora` to `'user'` and the search
  never leaves My Drive.
- New optional `include_shared_drives` param, **defaulting to true**: a file the user can
  see is a file they expect to find. `false` narrows to My Drive
  (`includeItemsFromAllDrives: false`, `corpora: 'user'`); `supportsAllDrives` stays true
  either way, since it governs how a shared-drive item is handled rather than whether one
  is searched for.
- `driveId` added to the requested fields, so a result that came from a shared drive can be
  told apart from one in My Drive. Description and README row updated.
- No new scope: the existing `drive.readonly` grant already covers shared-drive reads.

### G6 — Reply-To (and From) through encodeAddressList + foldHeader — DONE
- Commit: `f83693a`
- FAIL-before: `3 failed | 160 passed (163)` in mime.test.ts.
- PASS-after: full suite **629 passed (629)**, typecheck clean.
- ⚠️ **BEYOND THE CONTRACT'S LETTER, flagged for the reviewer:** the contract named
  Reply-To only. Reading the builder showed `From` on the same unencoded path — the same
  one-line defect, three lines above, and the MORE likely one to bite: From carries the
  account's own Gmail display name on **every message it ever sends**, so the first
  account with an accented name garbles everything, not just replies. Fixing one and
  leaving the other in the same edit would have been indefensible, so both moved to
  `addAddressHeader`. If the chair wants From reverted to keep the unit's blast radius at
  exactly the contract's words, it is a one-word change.
- Zero risk to existing sends: `encodeAddressList` is the identity on any pure-ASCII list,
  and `foldHeader` is a no-op below 78 chars — pinned by a new byte-identical test over the
  four ASCII shapes real sends use, and by the pre-existing From assertion in the forward
  tests, which still passes unmodified.

### G7 — version / dist hygiene — DONE
- Commit: `7a1107a`
- No FAIL-before: this unit has no testable defect. Suite unchanged at **629 passed (629)**,
  typecheck clean under the new tsconfig.
- `package.json` version **1.1.0 → 1.7.0** (it had not moved through six CHANGELOG
  releases). CHANGELOG gains a `[1.7.0] — 2026-08-28` entry, written in plain language,
  covering G1-G6; **G8-G12 are appended to that same entry as those units land**, so the
  round ends with one complete release note rather than twelve fragments.
- **The `build` script is REMOVED and `tsconfig.json` now sets `"noEmit": true`.** The
  contract allowed keeping `build` only if it could not silently produce a divergent
  artifact — it could: the server runs from `src` via `tsx`, nothing consumes compiled
  output, and `npm run build` would happily refresh a `dist/` that looks like the code
  that runs. `noEmit` makes the divergent artifact *impossible* rather than merely
  unscripted (a bare `tsc` now writes nothing), which is the structural version of the
  same fix. `outDir` and `declaration` went with it. CI never used `build`
  (it runs `typecheck` + `test` only), so nothing else changes.
- README gains a short "there is no build step, on purpose" note under Testing, with the
  `rm -rf dist` line.
- ⚠️ **ONE RESIDUE FOR THE CHAIR — I could not do this half.** The stale April `dist/`
  exists in the **live checkout** (`/Users/steve/Claude-Projects/2-backbone/advanced-gmail-mcp/dist`,
  untracked and gitignored). Deleting it means touching the live checkout, which the
  contract's concurrency rule forbids me outright. It is already gitignored, so it can
  never be committed; it is now also unreproducible. The chair should run, at acceptance:
  `rm -rf /Users/steve/Claude-Projects/2-backbone/advanced-gmail-mcp/dist`

### G8 — export-streaming hardening (chair ruling Q12) — DONE
- Commit: `8f6e898` (code) + this docs commit
- FAIL-before: **13 failed (13)** in the new `src/tools/drive-read-file.test.ts` (neither
  `readStreamToCap` nor `capBuffer` existed).
- PASS-after: full suite **642 passed (642)**, 16 files, typecheck clean.
- The `files.export` branch now uses `responseType: 'stream'` and `readStreamToCap`, which
  reads until one byte past the cap, then **destroys the stream** so the transfer actually
  stops. A 50MB exported Doc no longer lands whole in the shared MCP process. The
  `alt=media` branch keeps its Range header (Drive honours Range there; export ignores it).
- Truncation detection unchanged in meaning: exactly at the cap is NOT truncated, one byte
  over IS.
- **Small correctness improvement folded in:** both read paths now cut through one shared
  `capBuffer`, which drops an incomplete trailing UTF-8 sequence instead of decoding it to
  U+FFFD. The old `capContent` left a replacement glyph at the boundary — corruption in the
  middle of the user's document rather than a visible cut. `capContent` delegates, so the
  two branches cannot disagree about what a truncated document looks like.
- A mid-transfer failure rejects rather than returning half a document as if whole.

## ⚠️ ENVIRONMENT INCIDENT — the machine's disk filled up during G8

Between the G8 code landing and its docs commit, the root volume hit **0 bytes free**.
Every `Bash` call and every file write failed with `ENOSPC` for several minutes; no shell
command could run at all. Space then returned (~350-500MB free) and G8 was committed
immediately. Nothing was lost: the FAIL-before/PASS-after runs above were real and had
already completed before the outage.

**This is a real operational risk for the rest of the round.** Free space is hovering under
1GB on a 228GB volume. If a later unit reports as blocked, check `df -h /` first — it is far
more likely to be this than anything in the code.

### G9 — audit log outcome edges — DONE
- Commit: `a23f8ca`
- FAIL-before: **15 failed | 8 passed (23)** in the new `src/gmail/audit-log.test.ts`.
- PASS-after: full suite **665 passed (665)**, 17 files, typecheck clean.
- New private `audited(event, fields, fn)` in client.ts wraps six of the seven paths:
  intent line first (`phase: 'start'`), then `phase: 'done'` at info, or `phase: 'failed'`
  at error with the reason. The error is re-thrown untouched — this only watches.
- Six via the helper: trash_email, delete_label, modify_thread, trash_thread, delete_draft,
  send_draft. **batch_trash is handled separately and deliberately:** it is the one path
  that never throws (it collects per-message failures), so its closing line carries the
  tally — `phase: 'failed'` at error with counts and the first reason when anything failed,
  `phase: 'done'` with the trashed count otherwise.
- The intent line was KEPT on every path, as the contract requires: it is what proves the
  call was reached at all, and it is written before anything can go wrong. Every line keeps
  its identifying field (message_id / thread_id / label_id / draft_id / count) and its
  account, so the two edges can be paired up in the log.
- Pinned by test: a `delete_label` refused by the G1 confirm gate logs **nothing at all** —
  the guard runs before the trail, so a refusal leaves no "delete_label" footprint.

### G10 — small roughness (Chat id formats, broken-draft read) — DONE
- Commit: `95a2fd4`
- FAIL-before: `1 failed | 125 passed (126)` in api.test.ts for the draft error, plus
  `src/chat/names.test.ts` unable to resolve its module at all (`./names.js` did not exist).
- PASS-after: full suite **675 passed (675)**, 18 files, typecheck clean.
- New `src/chat/names.ts` holds `toSpaceParent` (moved out of chat-list-messages.ts, where
  it was private) and a new `toMessageName`. One module, so the two tools' acceptance
  cannot drift apart again. `get_chat_message` now takes the name with or without the
  leading `spaces/`, exactly as its sibling takes the space id, and a **bare message id is
  refused with an explanation** rather than passed to Google to fail as a malformed name —
  a message genuinely cannot be found from its id alone, since it belongs to a space.
- `get_chat_message` also picked up the G3 honesty wiring (`googleApiCall` with the Chat
  messages scope) while it was being edited — it is the fifth Chat/Drive/Docs read tool and
  was the only one still on the bare `withRetry` path.
- `readDraft` on a draft with no message now says what that state IS (a shell created and
  never saved with content) and names a way out (`delete_draft`, or open it in Gmail),
  instead of "Draft X has no underlying message."
- **NOT done, and deliberately:** the evidence pack also mentions `get_chat_message` having
  no size cap. The contract's G10 names exactly two items and that is not one of them, so
  it was left alone rather than widened. Flagging it so the reviewer knows it was seen.

### G11 — Docs write: the one new-scope feature — DONE
- Commit: `f88cade`
- FAIL-before: `src/tools/docs-update-document.test.ts` could not load its module at all
  (`./docs-update-document.js` did not exist) — **no tests ran**.
- PASS-after: full suite **689 passed (689)**, 19 files, typecheck clean. Roster **50 → 51**.
- ONE tool, `update_google_doc`, with the minimal surface the contract asked for:
  **append text at the end** (`insertText` with `endOfSegmentLocation`, never a computed
  index) and **find-replace** (`replaceAllText`). A test asserts the built request JSON
  contains no `"index"` at all — that is the whole point of the design: an index is a
  position in a document the caller cannot see, and one wrong by two silently rewrites the
  wrong paragraph.
- Replacements are ordered **before** the append, so text added in the same call cannot be
  rewritten by a rule in that same call.
- Refusals before any network call: a call that would do nothing (neither append nor
  replacements), and an empty/whitespace `find`.
- **A replacement that matched nothing is called out** in the result. batchUpdate succeeds
  either way, so without this the tool would report a clean success for an edit that never
  happened and the caller would tell the user the document had changed.
- Logged on both edges like the G9 destructive paths (start / done / failed).
- SCOPES: `documents.readonly` **replaced** by `documents` in `src/gmail/auth.ts` (the
  contract said "auth.ts"; the scope list actually lives in `src/gmail/auth.ts` —
  `src/auth.ts` is the CLI). `documents` covers reading, so both Docs tools now travel on
  one grant: `DOCS_READONLY_SCOPE` became a single `DOCS_SCOPE` that both quote. **No
  re-auth was run by me.** Until each alias re-consents, BOTH Docs tools 403 — and thanks
  to G3 they say exactly that, naming the scope and `npm run auth -- <alias>`.
- **Restated, not loosened:** `read-only-tools.test.ts`'s `get_google_doc` scope assertion
  moved from `documents.readonly` to `auth/documents`, because the scope that tool requires
  genuinely changed. No other assertion in that file moved.
- Unit tests mock the Docs API throughout. **No live document was touched.**
- Consent round + live acceptance are the CHAIR's step, per the contract.

### G12 — RULED BUILD: watcher server-side cursor persistence — DONE
- Commit: `5347551`
- FAIL-before: `13 failed | 133 passed (146)` across api.test.ts + the new
  `src/gmail/cursor-store.test.ts`.
- PASS-after: full suite **709 passed (709)**, 20 files, typecheck clean.
- New `src/gmail/cursor-store.ts` (+ `getCursorDir()` in config.ts) stores the last
  position per account in `cursors/<alias>.json`, **beside `tokens/` and gitignored**.
  `GMAIL_MCP_CURSOR_DIR` overrides the location — the same escape hatch the log has, and
  how the tests keep their writes out of the project.
- `get_mail_changes` gains the "since last time" default: `history_id` is now **optional**,
  and omitting it continues from the remembered position. **A supplied cursor still wins** —
  remembering is a default, not a lock.
- Three rules, each pinned by test:
  1. **Only a COMPLETE read is stored.** Gmail returns the mailbox's current position, not
     the end of the page, so storing mid-pagination would skip every unread page. The tool
     always documented that trap; this makes it structurally impossible to fall into.
  2. **The store only moves forward.** A write that would rewind is refused — a rewind
     replays a window already reported, which reads as the same mail arriving twice.
     Compared with BigInt, so a history id past 2^53 keeps its precision.
  3. **Best-effort, never breaks a poll.** A corrupt file reads as "nothing remembered"; a
     failed write is reported in the result's `note` rather than silently implying the
     bookmark moved.
- **No silent start from "now".** With nothing remembered and nothing supplied, the call is
  refused with instructions, because starting at "now" would report a mailbox with a week
  of unseen changes as having none.
- The alias is sanitized before it becomes a filename, so an alias containing a slash
  cannot write outside the cursor directory (pinned by test).
- `get_history_baseline` deliberately does NOT write the store: it returns "now", so
  storing it could clobber an older remembered position and lose the window between.

## ⚠️ SECOND ENVIRONMENT INCIDENT — the scratchpad worktree was DELETED mid-G12

After the earlier disk-full outage, a system cleanup freed ~4GB by **deleting the contents
of the scratchpad**, including this worktree's entire checkout and its `.git` file. The
in-progress (uncommitted) G12 edits were lost with it.

**Nothing committed was lost.** A worktree's objects and refs live in the REAL repo's
`.git`, so every commit G1-G11 survived intact on `feat/round2-enhancements`. The worktree
was recreated with `git worktree prune` + `git worktree add <path> feat/round2-enhancements`,
`npm install` re-run, and the suite re-verified at **689 passed** before G12 was redone from
scratch. The live checkout was never touched and is still on `main` at the baseline sha.

This is the commit-as-you-go rule earning its keep: the at-risk window was exactly one
unit, and one unit is what had to be redone.

---

## ROUND COMPLETE — all twelve units (G1-G12) done

- **Branch:** `feat/round2-enhancements`, 26 commits off baseline
  `a513a81089f46e6c5c8d1b1d383f3c657d8f7609`. **Not pushed** (forbidden, and correctly so).
- **Final gate:** `npm test` → **20 files, 709 passed, 0 failed**; `npm run typecheck` →
  clean, exit 0. Baseline for comparison was **13 files, 578 passed** — so **+131 tests,
  zero failures, zero pre-existing tests deleted**.
- **Tool roster: 51** (`grep -c "server.tool(" src/tools/*.ts` = 51), up from 50 — the one
  addition is `update_google_doc`.
- **Worktree is clean.** Nothing uncommitted.

### Tests RESTATED rather than loosened (the full list, for the reviewer)
Every one of these changed a CALL SITE because the contract of the thing being called
changed. **No assertion was weakened, and no test was deleted.**
1. `deleteLabel({ labelId: 'L1' })` → `+ confirm: true` (G1 — confirmation is now enforced).
2. The mailto-unsubscribe fallback test → `+ confirm: true` (G1 — the send is now gated).
3. `get_google_doc`'s expected scope, `documents.readonly` → `auth/documents` (G11 — the
   scope that tool requires genuinely changed).

### Work done BEYOND the contract's literal words (flagged, all reversible)
1. **G6 also fixed `From`**, not just `Reply-To` — identical defect three lines above, and
   the larger blast radius (From carries the account's own display name on every message).
2. **G3 lifted `translateCalendarError` into a shared module** rather than copying it into
   four tools; Calendar delegates and its 49 tests are untouched and green.
3. **G8 folded in one `capBuffer`** for both Drive read paths, so a document cut at the cap
   no longer ends in a U+FFFD replacement glyph.
4. **G10 also wired `get_chat_message` into the G3 honesty path** — it was the fifth
   Chat/Drive/Docs read tool and the only one still on bare `withRetry`.
5. **G7 removed the `build` script and set `noEmit`** rather than keeping a script that
   could silently produce a divergent artifact (the contract explicitly permitted this).

### Left for the chair
- The consent round: `npm run auth -- <alias>` for every alias, for the `documents` scope.
- Live acceptance (image-block read, unsubscribe refusal, shared-drive search, Docs write).
- `rm -rf /Users/steve/Claude-Projects/2-backbone/advanced-gmail-mcp/dist` (see G7).
- Two chair calls recorded in `QUESTIONS-FOR-FABLE.md` under `## ROUND 2 QUESTIONS`
  (R2-Q1: whether `update_google_doc` should take a `confirm`; R2-Q2: the `dist/` residue).

### Concurrency note — another session was working the live checkout during this build
At the START the live checkout was clean, on `main` at the baseline sha. By the END it had
three UNTRACKED items that are not mine and that I did not touch: `.vscode/`,
`SIGNATURE-BANNER-MOCKUPS.md`, `sig-mockups/`. That is another session's work in progress.
The live checkout is still on `main` at `a513a81` — its branch was never switched and no
tracked file in it was modified by this build. Worktree isolation did its job.

---

# ROUND 2 FIX PASS (W-F) — the five confirmed review findings

Worker: W-F (fix pass for the confirmed Round 2 review findings). Same frozen contract, same
prohibitions. Worktree `/Users/steve/Claude-Projects/2-backbone/advanced-gmail-mcp-wt/round2`
on `feat/round2-enhancements`.

## Fix-pass baseline (read fresh, before any edit)

- Branch head at start: **`736aebc`** — "docs(progress): note the concurrent session's
  untracked files in the live checkout". Worktree **clean**.
- `npm test` → **20 files, 709 passed, 0 failed. GREEN.**
- `npm run typecheck` → **clean, exit 0.**
- Gate for this pass: **709 + new tests, zero failures, nothing deleted or loosened.**
- Disk before starting: `df -h /` → 5.8Gi available (the volume hit 0 once during the build).
- The repo's LIVE checkout was not touched at any point in this pass.

## Findings

### WR-1 — read_drive_file could not open the shared-drive files G5 made findable — FIXED
- Commit: `fcf2d75`
- **FAIL-before (real):** added a handler-level describe to `src/tools/read-only-tools.test.ts`
  (the file that already mocks the Drive client) pinning the parameters of both `files.get`
  calls. Three failures at HEAD: `supportsAllDrives` undefined on the metadata call, undefined
  on the `alt=media` call, and `driveId` absent from the metadata `fields`.
- **Fix:** `supportsAllDrives: true` on the metadata `files.get` (`src/tools/drive-read-file.ts`)
  and on the `alt=media` `files.get`; `driveId` added to the metadata `fields`, so the answer
  says when a file lives in a shared drive. `files.export` takes no such parameter and was left
  alone. The tool description now states that shared drives are read too.
- Full suite after: **20 files, 713 passed** (+4), typecheck clean.

### WR-3 — read_drive_file was the last Drive/Docs read tool on bare withRetry — FIXED
- Commit: `d3919b3`
- **FAIL-before (real):** added `read_drive_file` to the existing 403-honesty case table in
  `src/tools/read-only-tools.test.ts` (the four-tool `describe.each`). Three failures at HEAD:
  the missing-scope, disabled-API and ordinary-forbidden cases all came back as
  "Authentication error (403) … Re-authenticate with: npx tsx src/auth.ts". The 401 case
  passed before and after — re-login IS the fix there, and it stays on that path.
- **Fix:** the same three-line shape the other five tools use — `resolveAccount`, build the
  `ctx` (`read_drive_file` / Google Drive / `DRIVE_READONLY_SCOPE` / alias), and swap all three
  `withRetry` calls for `googleApiCall`. No new machinery; `withRetry` is no longer imported here.
- Why it matters more after G5: Drive's commonest 403 is a permission on the FILE, which
  re-authenticating cannot fix, and search now returns shared-drive files the account may only
  partly reach.
- Full suite after: **20 files, 717 passed** (+4), typecheck clean.

### WR-2 — a foreign history_id permanently poisoned an account's remembered cursor — FIXED
- Commit: `6fcaa9c`
- **FAIL-before (real):** four new tests in `src/gmail/api.test.ts` under "getMailChanges
  remembers where it got to". At HEAD all four failed: polling with `history_id: 999999999`
  against a mailbox at 5000 wrote `999999999` into the store, which then could never be
  corrected (writeCursor only moves forward), so every later cursor-less poll started from a
  position no mail will ever reach and reported nothing.
- **Fix (`src/gmail/client.ts`):** the rewind guard now records that it fired (`foreignCursor`),
  and a proved-foreign position is **never written to the store**. The value is still carried
  back to the caller unchanged, so no window is replayed — only the durable state is protected.
- **The cure, for an account wedged before this fix:** when the guard fires and the poll ran on
  the REMEMBERED cursor, the note now says the stored cursor is the culprit, names the exact
  file to delete (`cursorFilePath`, newly exported from `src/gmail/cursor-store.ts` because the
  directory is env-configurable and the alias is sanitized into the filename), and says to poll
  once with a fresh `get_history_baseline` cursor. When the foreign cursor came in as an
  argument, the note says plainly that it was not remembered and the stored position is untouched.
- **Deliberately NOT done — and why:** auto-healing the store (writing the mailbox's own
  `response.data.historyId` over the stored value) was considered and rejected. It requires
  bypassing the monotonic rule, and Gmail's `history.list` historyId can legitimately lag the
  profile historyId across replicas — so an auto-heal would sometimes rewind a GOOD bookmark and
  replay mail as new. Skipping the write is safe in every case; healing is not. Recorded as an
  open item in `QUESTIONS-FOR-FABLE.md`.
- Full suite after: **20 files, 721 passed** (+4), typecheck clean.

### WR-5 — the unsubscribe mailto send logged intent, not outcome — FIXED
- Commit: `9cda2ca`
- **FAIL-before (real):** added `unsubscribe_mailto` to the existing G9 both-edges case table in
  `src/gmail/audit-log.test.ts` (its api mock gained `messages.send`). Two failures at HEAD: no
  completion line on success, and no failure line when the send threw — the intent line stood
  alone and read exactly like a delivered unsubscribe.
- **Fix (`src/gmail/client.ts`):** the send is wrapped in the round's own `audited()` helper, the
  same as the other seven destructive paths. Intent line before, `phase: 'done'` after, or
  `phase: 'failed'` at error level with the reason; the error is re-thrown untouched.
- Full suite after: **20 files, 724 passed** (+3), typecheck clean.

### WR-4 — the docs stated a falsehood about the scope swap — FIXED
- Commit: `1d3a06f`
- **Verified independently before rewriting** (this is the finding's whole substance):
  `SCOPES` is referenced exactly once in the codebase — `src/gmail/auth.ts:149`, inside
  `generateAuthUrl`. `getAuthClient` (`src/gmail/auth.ts:95-131`) only reads the token file and
  refreshes it; there is no scope validation anywhere. So editing the SCOPES array revokes
  nothing: an existing token still carries `documents.readonly` (and `drive.readonly`), either
  of which Google accepts for `documents.get`. **`get_google_doc` does not break. Only
  `update_google_doc` 403s.**
- **Not testable** — the claim is about Google's authorization server, not about this code. It
  is a documentation correction, and the corrected text is what the chair's live acceptance
  will be read against.
- **Fixed in four places:** `README.md` (the consent-screen bullet and the "Adding a scope means
  re-consenting" blockquote — the swap is now stated as read-compatible), `CHANGELOG.md` (the
  1.7.0 `documents` bullet), and `src/tools/docs-update-document.ts` (the tool description now
  says the 403 is on THIS tool and that reading is unaffected).
- **Four other 1.7.0 release-note bullets brought in line with what actually shipped in this fix
  pass**, so the notes are not a second source of falsehood: shared drives can now be READ as
  well as searched; the 403-honesty fix covers reading a Drive file; a cursor from another
  account is never written down; the audit trail's list of destructive acts includes the
  unsubscribe send.
- `src/gmail/auth.ts` and `src/docs/client.ts` were checked and need no change — both already
  scope their re-consent statements to `update_google_doc`.
- Full suite after: **20 files, 724 passed** (unchanged — docs only), typecheck clean.

## FIX PASS — final gate

- `npm test` → **20 files, 724 passed, 0 failed.**
  Fix-pass baseline was **709 passed**, so **+15 tests, zero failures, zero tests deleted.**
  The only removed lines in any test file are two mock DECLARATIONS that were widened
  (`driveApi.files` gained `get`/`export`; the audit-log `messages` mock gained `send`).
  No assertion was weakened.
- `npm run typecheck` → **clean, exit 0.**
- Worktree clean; branch `feat/round2-enhancements`.

### Commits, in order
| Finding | Commit | What it fixes |
|---|---|---|
| WR-1 | `fcf2d75` | `read_drive_file` can open a shared-drive file (both `files.get` calls declare support; metadata carries `driveId`) |
| WR-3 | `d3919b3` | `read_drive_file` joins the honest-403 path (`googleApiCall`) — a per-file permission no longer says "re-authenticate" |
| WR-2 | `6fcaa9c` | a cursor proved foreign is never written to the watcher store; the note names the cure for an account wedged earlier |
| WR-5 | `9cda2ca` | the unsubscribe mailto send logs its OUTCOME, through the round's own `audited()` helper |
| WR-4 | `1d3a06f` | the scope swap is read-compatible: docs corrected in README, CHANGELOG and the tool description |

### Scope notes for the validator
- All five confirmed findings are in the **gmail** repo. The CRM worktree
  (`crm-api-lambda-wt/contact-company-filter`, head `d97f353`) had no finding and was **not
  touched** — not a file read into, not a command run in it beyond `git log -1`.
- Nothing was skipped and nothing went to QUESTIONS as a blocker. One item was RECORDED there
  (`R2-Q3`): whether a watcher cursor poisoned before this fix should heal itself automatically
  or stay clearable by hand. The poisoning path is closed either way.
- The repo's LIVE checkout was never touched in this pass.
