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
- Commit: `PENDING-SHA-G10`
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
