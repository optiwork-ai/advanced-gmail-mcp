# PROGRESS — feat/drive-convert-sheets-write (base 24d811b)

Branch `feat/drive-convert-sheets-write`, cut from `24d811b` (v1.9.0, 846 tests, typecheck
clean). Contract: `shared/active-work/2026-09-01-drive-convert-sheets-write/BUILD-CONTRACT.md`.

Builder session. NO live Google call was made from this branch. The harness in the lane
folder is written here and RUN BY THE CHAIR.

## Baseline, measured in this worktree before any change

```
Test Files  24 passed (24)
     Tests  846 passed (846)
npm run typecheck → clean (no output)
```

## Units

| # | Unit | Commit | State |
| --- | --- | --- | --- |
| 1 | Piece A tests (convert-on-upload) | see git log | DONE |
| 2 | Piece A implementation | see git log | DONE — 884 pass, typecheck clean |
| 3 | Piece B tests (Sheets write) | see git log | DONE |
| 4 | Piece B implementation + registration | see git log | DONE — 928 pass, typecheck clean |
| 5 | Docs + CHANGELOG 1.10.0 + version | see git log | DONE |
| 6 | Live-acceptance harness + fixtures | see git log (journal only) | DONE — --dry clean |

## FAIL-before evidence

Recorded per unit below, as the failing summary from `npm test` run against the tests-first
commit with the implementation absent.

### Unit 1 — Piece A tests, run against v1.9.0 code (no implementation)

Command: `npm test` in this worktree, at the unit-1 commit.

```
Test Files  3 failed | 22 passed (25)
     Tests  29 failed | 855 passed (884)
```

Every failure is missing behaviour, not a syntax error: the exports the tests reach for
(`CONVERT_TARGET_BY_SOURCE_MIME`, `CONVERTIBLE_EXTENSIONS`, `convertTargetForFilename`,
`GOOGLE_SHEET_MIME`, `GOOGLE_SLIDES_MIME`), the `convert` option on `uploadFile` and on the
tool, the `convert_to` log field, and five `mimeTypeForFilename` extensions do not exist yet.
The 855 that pass are the untouched suite plus the pins on behaviour v1.9.0 already had.

`npm run typecheck` at this commit reports those same absences — a tests-first commit does not
typecheck clean by construction. It is clean again at unit 2.

The 29 failures:

- `src/drive/client.test.ts > the conversion map > names the three Google types by their real mimeTypes`
- `src/drive/client.test.ts > the conversion map > maps every spreadsheet source Google accepts, and only to a Google Sheet`
- `src/drive/client.test.ts > the conversion map > maps the document sources to a Google Doc`
- `src/drive/client.test.ts > the conversion map > maps the presentation sources to Google Slides`
- `src/drive/client.test.ts > the conversion map > invents nothing beyond those thirteen — every entry is one Google can import`
- `src/drive/client.test.ts > the conversion map > does not offer to convert a PDF or an image — Drive stores those as they are`
- `src/drive/client.test.ts > the conversion map > every extension the refusal advertises really does resolve into the map`
- `src/drive/client.test.ts > the conversion map > advertises all thirteen extensions, so nothing supported is hidden from the caller`
- `src/drive/client.test.ts > convertTargetForFilename > answers with the Google type an upload of that name would become`
- `src/drive/client.test.ts > convertTargetForFilename > answers undefined for anything Google will not convert`
- `src/drive/client.test.ts > uploadFile with convert > names the TARGET google type on the metadata and keeps the real type on the media`
- `src/drive/client.test.ts > uploadFile with convert > reports the type Google actually returned, and says the file was converted`
- `src/drive/client.test.ts > uploadFile with convert > converts a .txt into a Google Doc`
- `src/drive/client.test.ts > uploadFile with convert > decides from the NAME the file will have in Drive, not just the local one`
- `src/drive/client.test.ts > uploadFile with convert > still parents into a folder when one is given`
- `src/drive/client.test.ts > uploadFile with convert > records the conversion in the log, still without the local path`
- `src/drive/client.test.ts > uploadFile refuses a conversion Google cannot do > refuses a PDF before any network call, and names what it can convert`
- `src/drive/client.test.ts > uploadFile refuses a conversion Google cannot do > refuses a file with no extension at all rather than uploading it unconverted`
- `src/drive/client.test.ts > uploadFile refuses a conversion Google cannot do > says which type it was asked to convert, so the message is diagnosable`
- `src/drive/client.test.ts > the default upload path is untouched by the convert option > logs convert_to as null when no conversion was asked for`
- `src/gmail/mime.test.ts > mimeTypeForFilename > maps a.ods`
- `src/gmail/mime.test.ts > mimeTypeForFilename > maps a.odt`
- `src/gmail/mime.test.ts > mimeTypeForFilename > maps a.odp`
- `src/gmail/mime.test.ts > mimeTypeForFilename > maps a.tsv`
- `src/gmail/mime.test.ts > mimeTypeForFilename > maps a.rtf`
- `src/tools/drive-upload-file.test.ts > upload_drive_file exposes the convert option > declares a convert parameter`
- `src/tools/drive-upload-file.test.ts > upload_drive_file exposes the convert option > describes what convert does in terms of what the user gets, not the mechanism`
- `src/tools/drive-upload-file.test.ts > upload_drive_file exposes the convert option > says in the tool description that an upload can land as a real Google file`
- `src/tools/drive-upload-file.test.ts > upload_drive_file exposes the convert option > passes convert:true straight through to the uploader`

### Unit 2 — Piece A implemented; the same suite green

```
Test Files  25 passed (25)
     Tests  884 passed (884)
npm run typecheck → clean
```

Judgment calls worth a validator's eye:

- The map is keyed by SOURCE mime type, not by extension, so a rename on the way up
  (`name: 'data.csv'` over a local `blob`) converts correctly and one entry covers every
  extension that types to it.
- `CONVERTIBLE_EXTENSIONS` exists only so the refusal can speak in the caller's vocabulary;
  a test walks it through `mimeTypeForFilename` into the map so the advice cannot drift.
- Five extensions (`ods`, `odt`, `odp`, `tsv`, `rtf`) were added to `src/gmail/mime.ts`.
  The contract authorises this ("add any missing mime.ts entries these extensions need").
  It is the one change that reaches beyond Drive: those five previously typed as
  `application/octet-stream`, so a `.ods` mail attachment now carries its real type too.
  That is strictly better typing, but it IS a behaviour change outside `upload_drive_file`
  and is called out here rather than buried.
- `size` in the result stays the local stat and is documented as such; `driveSize` is simply
  absent for a converted file rather than being filled in from the local number.

### Unit 3 — Piece B tests, run with no Sheets module in the tree

Command: `npm test` in this worktree, at the unit-3 commit.

```
Test Files  3 failed | 24 passed (27)
     Tests  3 failed | 882 passed (885)
```

Two of the three failing FILES cannot even load, which is the honest shape of "the thing
does not exist yet":

```
Error: Failed to load url ../sheets/client.js (resolved id: ../sheets/client.js) in
  .../src/tools/sheets-write.test.ts. Does the file exist?
```

- `src/tools/sheets-write.test.ts` — 34 assertions across the two tools; the whole file is
  blocked on `src/sheets/client.ts`, `./sheets-update-values.js` and `./sheets-append-rows.js`.
- `src/gmail/auth-scopes.test.ts` — same missing module, reached through its new import of
  `SHEETS_SCOPE`. Its four pre-existing tests are collateral at this commit and green again
  at unit 4.
- `src/tools/index.test.ts` — loads fine and fails on the substance, which is the useful
  half of the evidence:
  - `registers 55 tools` — got 53;
  - `is exactly the read side plus the write side` — the two Sheets names are listed on the
    write side and are not in the roster;
  - `actually registers both of them`.

No existing assertion was weakened anywhere. The only edit to an existing test file is
`auth-scopes.test.ts`, which gains two tests and changes none.

### Unit 4 — Piece B implemented and registered; whole suite green

```
Test Files  27 passed (27)
     Tests  928 passed (928)
npm run typecheck → clean
```

Roster 53 → 55. Judgment calls worth a validator's eye:

- **Where the "created elsewhere" explanation is produced.** It runs INSIDE `googleApiCall`,
  on the raw Google error, because the reason codes that tell an out-of-reach spreadsheet
  apart from a missing scope or a disabled API do not survive the shared translation. The
  replacement error carries no status, so neither `withRetry` nor the translator touches it
  again, and every other failure (missing scope, accessNotConfigured, rate-limit 403, 401)
  reaches the shared translator exactly as before. Pinned by four tests per tool.
- **`insertDataOption: 'INSERT_ROWS'` on append.** Google's default is OVERWRITE, which
  writes into the cells after the table whether or not something is already there. Not a
  contract instruction; chosen because everything else this server does to a file creates
  rather than destroys. Named in the tool description and the README.
- **`maxRetries: 0` on append, retries left on update.** `values.update` is idempotent;
  `values.append` is not, and a retried append after a landed write adds every row twice.
  Same trade `create_google_doc` and `post_chat_message` already make.
- **Shared params went to `src/tools/shared-params.ts`**, the file that already exists for
  this, rather than one tool importing a zod schema out of its sibling.
- `src/tools/index.test.ts` is a NEW test the repo did not have: it pins all 55 tool names
  split into a read list and a write list, so a write tool can never be added without being
  named as one.

### Unit 5 — docs, CHANGELOG 1.10.0, version 1.10.0

Suite unchanged and green (27 files / 928 tests), typecheck clean.

- `README.md`: features line 53 → 55 tools; two new Cloud-setup bullets (no scope needed for
  Sheets, and the one project switch that IS needed); the `upload_drive_file` row rewritten
  with `convert` and the full convertible list; a new **Sheets** section explaining the
  drive.file boundary and the upload-converted-then-write loop; the Chat/Drive/Docs heading
  now says Sheets too.
- `CHANGELOG.md`: `## [1.10.0] — 2026-09-01`, Keep-a-Changelog voice. It says in the second
  paragraph that NO fresh sign-in is needed, and in the third that one console switch may be
  needed once and that the error itself names it.
- `package.json`: 1.10.0. (`package-lock.json` says 1.0.0 and always has — it never tracked
  this version, so it was left alone rather than quietly changed here.)
- `.claude/commands/email.md`: the `upload_drive_file` row gains `convert`, and the two
  Sheets tools are added to the table with their limits. Not named in the contract's G5, but
  the file is a tool table this release makes wrong, and leaving it stale is how a caller
  learns about `convert` from nowhere.

### Unit 6 — the live-acceptance harness (chair runs it; this session made NO live call)

Written to `shared/active-work/2026-09-01-drive-convert-sheets-write/live-acceptance/`:
`convert-sheets.ts`, `README-RUN.md`, an ESM `package.json`, and two generated fixtures
(`fixture.csv` — four rows with a number, a decimal, a comma-quoted string containing an em
dash, and a percent sign; `fixture.txt` — two short paragraphs).

`--dry` from the worktree, clean, exit 0:

```
DRY RUN: every module imported cleanly. No network call was made.
  uploadFile accepts convert: yes
  conversion map entries: 13
  convertible extensions: xlsx, xls, ods, csv, tsv, docx, doc, odt, rtf, txt, pptx, ppt, odp
  update_sheet_values registered: yes
  append_sheet_rows registered:   yes
  read_drive_file registered:     yes
  convertTargetForFilename(fixture.csv) → application/vnd.google-apps.spreadsheet
  convertTargetForFilename(fixture.txt) → application/vnd.google-apps.document
  convertTargetForFilename(deck.pptx) → application/vnd.google-apps.presentation
  convertTargetForFilename(scan.pdf) → undefined
```

Design notes for the chair and the validator:

- H-A0 is the AUTHORITY for the conversion map: it reads Google's own
  `about.get({ fields: 'importFormats' })` and looks every shipped entry up in it. It also
  prints, as information only, what Google imports that the map does not claim.
- The two write tools and `read_drive_file` are driven through the handlers the MCP server
  actually registers, so what is exercised is the call Claude would make, argument names
  included — not a private function underneath.
- H-B1 recovers the real first-sheet title from the range Google echoes back and uses it for
  the append, so a spreadsheet whose first tab is not "Sheet1" does not fail on a guess.
- A Sheets-API-disabled 403 marks the B-checks SKIP-BLOCKED (never FAIL) and prints an
  `ACTION FOR STEVE` line with the console URL.
- H-Z always runs; anything it could not bin is printed as a `DELETE BY HAND` line with a
  Drive URL, rather than swallowed.
- ONE account by default (`steve-optiwork`, `--account=` to re-aim): what is under test is
  per-project and per-grant, not per-account.

**Not committed to git.** These files live in `shared/`, which belongs to the chair's
workspace repo, and the entire lane folder — the chair's own contract and checklist
included — is untracked there. Staging part of it from a worker session would be reaching
into the chair's repo. The files are on disk at the contracted path.

---

# PROGRESS — feat/calendar-meet-link (base b8adaa6)

`add_meet` on `create_calendar_event`: create the event WITH a Google Meet room,
return the link and its status, re-read a `pending` room until the link exists.
Contract: `shared/active-work/2026-09-01-gmail-meet-link/BUILD-CONTRACT.md`.
Worktree: `/Users/steve/Claude-Projects/2-backbone/advanced-gmail-mcp-wt/meet-link`.

## Baseline at b8adaa6 (measured, not assumed)

- `npm test`: **829 tests, 828 pass, 1 FAIL** — `src/gmail/settings-api.test.ts >
  setVacation > refuses an inverted window`. **Pre-existing and unrelated to this
  lane**: the test hardcodes `2026-09-08` → `2026-09-01`, and as of today
  (2026-09-01) the *already-ended* refusal fires before the *inverted* one, so the
  assertion on `/must be after/` misses. A date bomb, not a regression. It was outside
  this contract's allowed file list, so it was written to `QUESTIONS-FOR-FABLE.md`
  instead of being fixed — **and the chair then ruled it fixed here: see U6.**
- `npm run typecheck`: clean.

## Units

- [x] **U1 — tests first, demonstrated failing** (`src/calendar/client.test.ts`) — SHA in U2's entry.
      17 new tests (13 in `describe('createEvent with add_meet')`, 4 in
      `describe('extractMeetLink')`) plus one existing test extended for the two new
      log fields the contract mandates (`add_meet`, `meet_status`) — that extension is
      the only edit to an existing test in this lane, and it is required by §2's
      logging instruction, not by the response shape (which is untouched when
      `add_meet` is unset).
      **FAIL-before evidence** — `npx vitest run src/calendar/client.test.ts` on the
      UNCHANGED client: `Tests  16 failed | 50 passed (66)`, i.e. every new assertion
      that needs the implementation fails, listed here in full:
      - createEvent > logs the creation with ids and counts only — no attendee addresses
      - createEvent with add_meet > asks Google for a hangoutsMeet room when add_meet is true
      - createEvent with add_meet > gives every request its own requestId
      - createEvent with add_meet > returns the link and a success status when the room is ready straight away
      - createEvent with add_meet > re-reads the event until the pending room turns into a link
      - createEvent with add_meet > reports a still-pending room without fabricating a link
      - createEvent with add_meet > reports a failed room, keeps the event, and does not poll
      - createEvent with add_meet > stops polling the moment Google reports failure
      - createEvent with add_meet > reads the link from the video entry point when hangoutLink is absent
      - createEvent with add_meet > keeps the created event when the re-read itself fails
      - createEvent with add_meet > logs whether a room was asked for and how it ended — never the link
      - createEvent with add_meet > logs add_meet false and a null meet_status on an ordinary event
      - extractMeetLink > prefers hangoutLink (TypeError: extractMeetLink is not a function)
      - extractMeetLink > falls back to the video entry point
      - extractMeetLink > ignores a video entry point with no uri
      - extractMeetLink > returns undefined when the event carries no conference at all
      The two add_meet tests that pass at this commit are the (a) pair — "adds nothing
      to the request when add_meet is unset / false" — which pass because today's code
      already sends nothing; they are the guard that the request stays byte-identical.
      `npm run typecheck` FAILS at this commit by design (`extractMeetLink`, `addMeet`
      and `sleep` do not exist yet); it is clean again at U2.
- [x] **U2 — `createEvent()` gains `addMeet`, the poll and the link extraction**
      (`src/calendar/client.ts`) — U1 is `5ea49a9`; this unit's SHA is in U3's entry.
      `conferenceDataVersion: 1` + a `hangoutsMeet` `createRequest` with a fresh
      `randomUUID()` requestId, sent ONLY when `addMeet` is true; `extractMeetLink()`
      (hangoutLink, then the video entry point); `conferenceStatusCode()` reading
      `status.statusCode` and tolerating a bare string; `resolveMeetRoom()` re-reading
      the event at 1s/2s/3s/4s/5s through the same `calendarCall` ctx, stopping on a
      link or on `failure`; the sleep injectable via `CreateEventOptions.sleep`.
      A re-read that THROWS does not throw away the event: the insert already
      happened, so the room is reported `pending` and the failure is logged as
      `create_calendar_event_meet_poll_failed` (an addition to the contract, made
      because propagating that error would report a created event as not created).
      The write log now carries `add_meet` and `meet_status` (never the link).
      **PASS-after:** `src/calendar/client.test.ts` 66/66 green; full suite
      **845 pass / 1 fail (846)** — the 1 is the pre-existing date bomb above;
      `npm run typecheck` clean.
- [x] **U3 — the tool gains `add_meet`** (`src/tools/calendar-create-event.ts`) —
      U2 is `2ca7278`; this unit's SHA is in U4's entry.
      `add_meet: z.boolean().optional()`, described plainly (attaches a Meet room and
      returns its link; emails nobody — `send_updates` alone decides that; what each
      `meetStatus` means). The tool description says the same in one clause. The
      handler passes `addMeet: add_meet ?? false`. No tool-level test: this layer is a
      passthrough and the repo tests the client, which is where the behaviour lives.
      typecheck clean, suite unchanged at 845 pass / 1 pre-existing fail.
- [x] **U4 — README + CHANGELOG 1.9.0 + version bump** — U3 is `1e8b55e`; this
      unit's SHA is in U5's entry. README: the `create_calendar_event` table row names
      `add_meet`, and the invitation-email paragraph is followed by a new
      "On `create_calendar_event` and the Meet room" paragraph covering the three
      statuses, the never-invented link, and the consumer-account caveat.
      CHANGELOG: `## [1.9.0] — 2026-09-01` in the 1.8.0 voice, saying plainly that no
      fresh sign-in is needed and nothing else changes. `package.json` → 1.9.0;
      `grep -rn '1\.8\.0' --exclude-dir=node_modules` finds no other maintained copy
      (the remaining hits are CHANGELOG history and PROGRESS-CHAT.md's record of that
      round, both of which SHOULD keep saying 1.8.0).
- [x] **U5 — live-acceptance harness** (chair runs it; this session made NO live call) —
      U4 is `5a1db90`. Written at
      `shared/active-work/2026-09-01-gmail-meet-link/live-acceptance/` — `meet-link.ts`,
      an ESM `package.json`, and `README-RUN.md` with the three exact commands (dry from
      the worktree, live against the worktree with the credential symlinks, live against
      the live checkout after merge). Per account, in `getAccounts()` order: H1
      `calendars.get` → `allowedConferenceSolutionTypes`; H2 `createEvent` with
      `addMeet: true`, `sendUpdates: 'none'` and NO attendees; H3 `events.delete` of the
      id H2 created, always attempted. Summary carries a dedicated line for `personal`,
      and names anything left undeleted. `--dry` output recorded in the builder report.
      NOT committed to the workspace repo — that tree holds a lot of unrelated in-flight
      work and the Round 2 harness was left untracked too (see QUESTIONS-FOR-FABLE.md #5).

- [x] **U6 — the vacation window tests stop expiring with the calendar**
      (`src/gmail/settings-api.test.ts`) — added on the chair's ruling, one commit, its
      SHA is the branch tip. Two tests carried fixed 2026-09 dates: the epoch-ms
      conversion test (`2026-09-01` → `2026-09-08`, which would have started failing on
      2026-09-08) and the inverted-window test (`2026-09-08` → `2026-09-01`, already
      failing today). Both now build their window from `daysFromNow(n)`, the relative
      idiom this file already used further down, and the conversion test asserts the
      epoch strings computed from those same values. The inverted-window test keeps BOTH
      ends in the future on purpose, because `setVacation` refuses an already-ended
      window one guard EARLIER than an inverted one — that ordering is exactly what the
      fixed dates had walked into. No assertion was weakened, no production code touched,
      no fake timers introduced. The file's remaining date literals are the deliberately
      stale 2016 window (permanently in the past by design) and prose in comments.
      **Suite now 846 passed / 0 failed; typecheck clean.**

- [x] **U7 — validation follow-up: two documentation fixes** (PASS-WITH-FIXES verdict,
      Steve-approved). Its SHA is the branch tip.
      **Fix 1 (this commit).** README and CHANGELOG both hedged that a personal
      `@gmail.com` account "may not" be able to have a Meet room attached through the API.
      The chair's live run disproved it — `personal` returned `meetStatus=success` with a
      real `meet.google.com` link, like the other four
      (`live-acceptance/RESULTS-2026-09-01.md`). Both sentences now say it was checked
      against Google and works on a personal account too, and keep the honest "if Google
      ever does refuse a room, the event is still returned" half, which is still true.
      **Fix 2 (harness, on disk, not committed).** `live-acceptance/meet-link.ts` H1 now
      calls `calendarList.get` instead of `calendars.get`: the CalendarListEntry carries
      the same `conferenceProperties.allowedConferenceSolutionTypes`, and reading it is
      covered by the `calendar.calendarlist.readonly` scope every account already granted,
      so H1 can actually pass instead of always answering "Insufficient Permission". The
      printed plan matches, and `README-RUN.md` now (a) says which scope H1 uses and why,
      (b) confines the "re-consent with `npm run auth`" advice to H2/H3 so an H1 failure
      never triggers a needless five-account re-consent, and (c) drops the now-disproven
      "a consumer account cannot have a room attached" expectation.
      Dry run re-run from the worktree: **exit 0**, plan line reads `calendarList.get`.
      Harness typechecks standalone under `--strict`. No live Google call; no credential
      file created, copied or symlinked.

## Rulings received from the chair (2026-09-01)

- **Q1 — `events.get` without `conferenceDataVersion`: deviation STANDS.** Verified
  independently against `googleapis` v3.d.ts; the contract's G2(d) was wrong. No change.
- **Q2 — fix it now, on this branch, as its own unit.** Done as U6 above.
- **Validation verdict: PASS-WITH-FIXES**, two documentation fixes. Done as U7 above.

## Live harness result (run by the chair against this worktree, credentials since removed)

- **`add_meet` PASSED on all five accounts** — `meetStatus=success`, real
  `meet.google.com` links, throwaway events deleted — **including the consumer
  (`personal`) account.** That answers the lane's open question: a consumer @gmail.com
  account CAN have a Meet room attached through the API.
- **H1 (the pre-check) FAILED on all five with "Insufficient Permission"**:
  `calendars.get` needs a scope this server does not request. That was a HARNESS-ONLY
  defect — it does not touch `add_meet`, which passed on every account. **Fixed in U7**:
  H1 now reads the same `conferenceProperties` from `calendarList.get`, which the
  already-granted `calendar.calendarlist.readonly` scope covers. No scope was added to
  the product and no account was re-consented.

## Open items for the chair / validator

- `shared/active-work/2026-09-01-gmail-meet-link/QUESTIONS-FOR-FABLE.md` — two rulings
  wanted: the `events.get` `conferenceDataVersion` deviation (G2 d), and the pre-existing
  red test that keeps `npm test` from being wholly green (G1).
- The live harness HAS now been run by the chair (result above). No live Google call
  was made by this builder session, before or after.

---

# PROGRESS — feat/gmail-native-outbound (base 536a9be)

Unit A of `shared/active-work/2026-08-27-gmail-mcp-upgrade/BUILD-CONTRACT.md`
(= `review-outbound.md` PART B, B0-B10, plus the two security items the contract
adds: CRLF/header-injection sanitation and `resolveAccount` hardening).

Unit B (builder W2) is the contract's "Quick wins" list, items 1-5.

## Unit A — done (builder W1)

- [x] **B10 acceptance gate written FIRST, demonstrated failing** — `src/gmail/acceptance.test.ts`
      (5 gates: multipart/alternative + 998-octet guard, quote block, From display name,
      two CRLF header-injection gates). FAIL-before run recorded: 5/5 failed against the
      old single-part builder. `buildRawMessage` exported and `MimeOptions` given the new
      optional suffix fields so the gate compiles; `src/gmail/mime.ts` stubbed.
- [x] **B1 + B2 + B4-partial `src/gmail/mime.ts` + `src/gmail/mime.test.ts`** — normalizeNewlines,
      escapeHtml, sanitizeHeaderValue (CRLF injection guard), encodeHeaderValue, foldHeader,
      formatFromHeader, parseAddress, reflowPlainText, textToHtml, htmlToText, formatGmailDate,
      buildQuoteBlock, buildForwardBlock, loadAttachment + MIME table, buildMimeMessage
      (multipart/alternative, multipart/mixed, base64 CTE, size gates). 95 unit tests, all green.
      `types.ts` gained Attachment / SendAsProfile / ComposeOptions.
- [x] **B3 `src/gmail/settings.ts` + `settings.test.ts`** — cached sendAs profile (50-min TTL),
      picked isDefault -> isPrimary -> email match, deliberately OUTSIDE withRetry so a 403
      degrades to an empty profile instead of killing the send. 8 tests, all green.
- [x] **B4/B5 + `client.ts` rewrite** — extractBody is first-wins and skips message/rfc822 and
      attachment parts (F5); buildRawMessage delegates to mime.ts; composeOutbound is the single
      composition path (signature then quote/forward block) and dispatchSend/dispatchDraft the
      single transport choice (raw under 5MB, media.body above); prepareReply now fetches
      format:'full', honours Reply-To, quotes the original, and names the account on a 404;
      buildReplyRecipients replaces the reply-all Cc folding; forward re-attaches the original's
      attachments. Unsubscribe pinned to plain_text_only. Full suite 173 green — the five B10
      acceptance gates now PASS.
- [x] **`resolveAccount` hardening** — pure `selectAccount` split out and unit-tested (12 tests);
      substring email matching removed (exact alias or exact email, case-insensitive both sides);
      the default lookup throws a named config error instead of a non-null assertion.
- [x] **B6 tool params + descriptions** — shared-params.ts holds the body/is_html contract wording
      and the new optional params; send/draft/reply/draft-reply/forward updated. Server still
      registers 34 tools (smoke-checked).
- [x] **B7 docs** — README tool count 35 -> 34, forward row no longer says "no attachments",
      Gmail-native feature bullet added; CHANGELOG 1.2.0 entry.
- [x] **B8 tests + B10 PASS-after** — 185 tests green, typecheck clean, all five B10 gates pass.

### B10 gate evidence (reproducible)

FAIL-before: `git worktree add --detach <dir> 915a8c0 && npx vitest run src/gmail/acceptance.test.ts`
-> 5 tests, 5 failed (multipart assertion, two not-implemented stubs, two Bcc-injection
assertions). PASS-after on HEAD: 5 passed. Full suite: 185 passed, typecheck clean.

### Not Unit A's worker's

- B10.5 live acceptance sends (send / reply / forward / draft+send, `[TEST]`-prefixed, raw
  verification) — the chair runs these.
- The >5MB media-upload transport is implemented and unit-covered on the size arithmetic, but
  the contract asks for it to be confirmed against one real send during acceptance. Not
  builder-runnable.

## Unit B — in progress (builder W2)

- [x] **Item 1 — `get_attachment` rebuilt** — `src/gmail/api.test.ts` harness (googleapis /
      auth / config all mocked) + the rebuild in `client.ts`: `save_dir` writes the file
      (sanitized filename from the message part, `-1`/`-2` collision suffix, `wx` flag so
      the create is atomic), inline base64 only up to 1MB and refused BEFORE download when
      the part table says it is bigger, filename + mimeType always returned, base64url
      decoded through Node so the `=` padding is correct. `fetchAttachmentBytes` split out
      as the unbounded low-level path the forward re-attach uses. 18 tests.

- [x] **Item 2 — thread ops** — `modify_thread` (add/remove label ids on every message in
      the conversation; archive = remove INBOX; a no-op call is refused rather than reported
      as success) and `trash_thread`, via `users.threads.modify`/`.trash`. Both logged.
- [x] **Item 3 — draft ops** — `update_draft` rebuilds the MIME through Unit A's
      `composeOutbound` and reuses `dispatchDraft` (now able to update as well as create, so
      the >5MB media path is shared rather than forked), preserving the draft's threadId;
      `delete_draft` is a permanent delete and is logged. 11 more tests.

- [x] **Item 4 — correctness repairs**, in five commits:
      - pagination + formats: #6 (default 50, cap 500, `page_token`, `nextPageToken`, the two
        drifted list loops merged into one), #16 (label+query ANDing documented), #18
        (`list_drafts` paginates), #11 (`read_email` metadata/minimal -> headers + `body_note`),
        #7 (`get_thread` HTML fallback + per-message attachments)
      - labels: #8 (no fabricated zero counts; `include_counts` fans out `labels.get` at
        concurrency 10), #9/#19 (never invent half a colour; fetch-and-preserve on partial
        update), #26 (empty modify/patch refused on `label_email` and `update_label`)
      - retry + batch: #12 (403 `rateLimitExceeded`/`userRateLimitExceeded` retried like 429,
        every other 403 still re-auth), #13/#14 (`batchModify` chunked at 1000 and reporting
        real outcomes; new `batchTrash` continues past failures at concurrency 10; the tool
        returns the client's result instead of synthesizing success)
      - chat/docs/drive: #17 (`order_by`, default `createTime desc`), #10 (table rows carry
        their own newline; flattener exported + tested), #21 (Sheets first-sheet-only and
        Slides speaker-notes losses declared in `contentNote`)
      - security: #1 (new `src/gmail/url-guard.ts` — https only, resolve-and-refuse
        private/loopback/link-local/CGNAT/reserved v4+v6, `redirect: 'error'`, 10s timeout;
        `parseUnsubscribeHeaders` left a pure parser so policy lives at the request site),
        #27 (`log()` wired into all twelve destructive paths)
- [x] **Item 5 — tests + docs** — 326 tests across 9 files; README tool count 34 -> 38 with
      every changed row rewritten; CHANGELOG 1.3.0; the bundled `.claude/commands/email.md`
      tool table updated for the new tools, params and return shapes.

## Remaining — Unit B

Nothing. Live acceptance (B10.5) is the chair's.

### Unit B verification (2026-08-27)

- `npm run typecheck` clean. `npm test`: **9 files, 326 tests, all passing** (baseline after
  Unit A was 185).
- Registration smoke run: **38 tools**, including all four new ones.
- Every Unit A test file (`acceptance`, `mime`, `client`, `settings`, `config`, `log`) is
  byte-unchanged by W2 — no baseline test was edited or loosened. The five B10 gates still
  pass when run alone.
- Prohibitions: no `accounts.json` / `credentials.json` / `tokens/` / `package.json` /
  `auth.ts` change (`git diff 536a9be..HEAD -- src/gmail/auth.ts` is empty), no new deps, no
  push/deploy, no live API call of any kind, no AI attribution.
- 14 items filed to `QUESTIONS-FOR-FABLE.md`; items 8, 9 and 12 want a decision. **Item 8 is
  the one to read first: three tools changed their return shape, which is breaking for
  callers outside this repo.**

## Unit C — done (builder W3)

- [x] **STEP 0 live read-only probe (steve-ah)** — `calendar.events.list` on `primary`
      returned 3 upcoming events; `calendarList.list` returned 5 calendars;
      `freebusy.query` returned `{"primary":{"busy":[]}}`. The Calendar API is enabled and
      the steve-ah token carries the calendar scopes, so the unit was cleared to build. No
      enable-URL question needed. The probe was a throwaway script, run and deleted; nothing
      was created on any calendar during this unit.
- [x] **`ebacdbc` — `src/calendar/client.ts` + the four tools.** Factory copied from the
      Chat/Drive/Docs template (per-account cache, 50-min TTL, `getAuthClient`), plus four
      API functions the tool files wrap:
      - `list_calendars` (`calendarList.list`, paginated, primary flagged) — read-only
      - `list_calendar_events` (`calendar_id` default `primary`, `time_min`/`time_max`,
        `query`, `max_results` default 50 cap 250, `page_token`/`nextPageToken`,
        `singleEvents: true` + `orderBy: 'startTime'`) — read-only
      - `get_freebusy` (`time_min`/`time_max` required and validated, `calendar_ids`
        default `['primary']`; a per-calendar `errors` entry is returned rather than
        failing the whole query) — read-only
      - `create_calendar_event` — the only mutating call. `send_updates` **defaults to
        `'none'`**; its description states plainly that `'all'` EMAILS every attendee.
        The result carries a `notice` saying whether anyone was mailed. Logged via `log()`
        with account / calendar id / event id / attendee count / send_updates — never
        attendee addresses or the body. `buildEventDateTime` refuses a date-only value for
        a timed event and a timestamp for an all-day one instead of guessing.
      34 unit tests in `src/calendar/client.test.ts` against a fully stubbed
      `calendar_v3.Calendar` (googleapis, auth, config and log all mocked) — the suite
      creates nothing.
- [x] **`e76b079` — docs.** README tool count 38 -> 42, a Calendar section in the tools
      table with the invitation-email behaviour spelled out, Google Calendar API added to
      the Cloud setup steps and the calendar scopes to the consent-screen list; CHANGELOG
      1.4.0.

### Unit C verification (2026-08-27)

- `npm run typecheck` clean. `npm test`: **10 files, 360 tests, all passing** (baseline
  after Unit B was 326; +34 from this unit, no pre-existing test changed — the Unit A and
  Unit B test files are byte-unchanged by W3).
- Registration smoke run: **42 tools**, including all four calendar tools.
- Prohibitions: no `accounts.json` / `credentials.json` / `tokens/` / `package.json` /
  `auth.ts` change, no new deps, no push/deploy, no AI attribution, no calendar write of
  any kind (the only live calls were the three read-only STEP 0 probes).

## Remaining — Unit C

Nothing. No questions filed.

## How to resume

`git log 536a9be..HEAD` for what landed. `npm run typecheck && npm test` from the repo
root. B10.5 (live sends) is the chair's, not a builder's.

## W4 — adversarial first pass (2026-08-27)

Review only; no source file was modified by this pass. Findings written to
`shared/active-work/2026-08-27-gmail-mcp-upgrade/REVIEW-FINDINGS.md`.

- Fresh run at `101614d`: `npm run typecheck` clean; `npm test` **10 files,
  360 tests, 360 passing**. Both builders' reported counts reproduce exactly.
  42 `server.tool(` registrations — README's "42 tools" is accurate.
- **8 CONFIRMED**, each with an executed reproduction: SSRF guard bypass via the
  hex form of an IPv4-mapped IPv6 address (`https://[::ffff:127.0.0.1]/` is
  allowed end-to-end with the real resolver); the 998-octet limit still violated
  by long non-ASCII headers (a 400-char subject emits a 1097-octet `Subject:`
  line); `reflowPlainText` welding sign-off and address blocks; the 25MB
  attachment allowance being unreachable behind a self-contradictory 35MB error;
  autolinking overrunning escaped `<`/`"`; `plain_text_only` silently dropping
  attachments; and two `htmlToText` parsing defects.
- **10 PLAUSIBLE** (media-upload threshold measured pre-base64, unvalidated
  attachment mimeType, 50-minute caching of a FAILED sendAs lookup, unencoded
  non-ASCII recipient display names, destructive `log()` calls firing before the
  API call, residual IPv6 SSRF surface + accepted DNS-rebinding risk, attachment
  load/download ordering, missing end>start check on `create_calendar_event`,
  RFC 2231 encoding, shared `withRetry` misreporting Calendar 403s).
- **18 DROPPED** with evidence, including: a 13-input header-injection battery
  (my own inputs, not the repo fixtures) that found no leak on any path; no
  baseline test deleted, edited or loosened; the one edited acceptance-gate
  assertion verified STRONGER than the one it replaced; attachment path handling
  clean (`wx` atomic create, traversal-flattened filenames); and every remaining
  Unit B and Unit C contract item checked off one by one.
- One design fork filed as QUESTIONS-FOR-FABLE item 15 (the reflow rule — both
  readings of B1c are wrong; a third is recommended but it rewrites the spec).

This is a same-model first pass and is NOT validation. W6's cold Fable pass
should re-derive C1 and independently re-run the B10 gate at `915a8c0` rather
than trusting this report.

## W5 — fix pass (2026-08-27)

Every fix has a test that FAILED before it and PASSES after; the counts below
are real vitest output. Baseline at `af3fe44` was 360 tests; HEAD is 413.

- [x] **`a8d582e` — C1 SSRF (high).** `url-guard.ts` expands an IPv6 address to
      its 16 bytes before judging it, so the hex spelling of an IPv4-mapped
      address is recognized. Covers IPv4-mapped, IPv4-translated,
      IPv4-compatible, NAT64 `64:ff9b::/32`, 6to4 `2002::/16` and Teredo; an
      unparseable address is refused rather than assumed public (also closes the
      residual surface W4 filed as P6). FAIL-before **17 failed / 61 passed**,
      PASS-after **78 passed**. Five of the new cases run against the REAL
      resolver — the stubbed one could not see what Node returns for a bracketed
      literal, which is why the existing 53 tests missed it.
- [x] **`54fe5cf` — C2 998-octet headers.** `encodeHeaderValue` splits a long
      value into 45-byte chunks on codepoint boundaries and emits several
      encoded-words, which `foldHeader` can then fold. FAIL-before **6 failed /
      98 passed**, PASS-after **104 passed**. One W1 test changed meaning: it
      asserted the joined encoded string survives a fold, which is the defect;
      it now asserts each word survives intact and unfolding reproduces the
      value. No baseline (`536a9be`) test touched.
- [x] **`cdbba7f` — C4 size arithmetic.** All three ceilings and `mb()` are
      decimal MB, so 25,000,000 bytes of attachments is actually usable and the
      ceiling message no longer claims 34.2 exceeds 35. FAIL-before **3 failed /
      103 passed** (including the reviewer's exact `expected 34.2 to be greater
      than 35`), PASS-after **106 passed**.
- [x] **`43d2867` — C5 autolink overrun.** The URL character class excludes `&`
      and re-admits only `&amp;`, so an escaped quote or angle bracket ends the
      link while a query-string ampersand does not. FAIL-before **3 failed /
      107 passed**, PASS-after **110 passed**.
- [x] **`8b91115` — C6 `plain_text_only` + attachments** is a refusal instead of
      a silent drop. FAIL-before 1 failed, PASS-after **402 passed** (full suite).
- [x] **`be87418` — C7/C8 `htmlToText`.** Quoted attribute values are consumed
      whole, so a `>` inside one no longer ends the anchor tag; the anchor
      placeholder token is random per call and NUL is stripped from the input,
      so the source document cannot forge it. FAIL-before 2 failed (reproducing
      W4's `b">label <http://q.com>` exactly), PASS-after **404 passed**.
- [x] **`432446c` — P2 + P9.** An attachment's content type is reduced to a bare
      `type/subtype` and must match a MIME token (falls back to
      `application/octet-stream`); RFC 2231 ext-values also percent-encode
      `' ! ( ) *`. FAIL-before 3 failed, PASS-after **407 passed**.
- [x] **`e5b02f9` — P3 negative caching.** A failed sendAs lookup is cached for
      60 seconds, not 50 minutes. FAIL-before 1 failed, PASS-after **409 passed**.
- [x] **`8dd8c40` — P8 calendar range.** `create_calendar_event` refuses an
      inverted or zero-length range before the API call, matching `get_freebusy`;
      an all-day `end === start` stays legal (the end date is exclusive).
      FAIL-before 3 failed, PASS-after **413 passed**.

### NOT fixed by W5, and why

- **C3 (reflow welds sign-off blocks)** — a design fork, filed by W4 as
  QUESTIONS-FOR-FABLE item 15 and still unanswered. Both readings of B1c are
  wrong and the recommended third rewrites the contract's stated join rule, so
  it is not the fix pass's call. Nothing else was downstream of it.
- **C2's ASCII sibling** — a single unbroken ASCII token longer than 998
  characters (`to: 'x'.repeat(1200) + '@b.com'`) still emits an over-length
  line. There is no legal way to fold an unbroken token; the alternatives are
  truncation or rejection, both worse. Recorded, not fixed.
- **P1, P4, P5, P6-residual, P7, P10** — see the W5 addendum in
  `REVIEW-FINDINGS.md`. Each needs a live call, a design ruling, or machinery
  out of proportion to the finding.

### W5 verification

- `npm run typecheck` clean. `npm test`: **10 files, 413 tests, all passing.**
- `src/gmail/client.test.ts`, `src/gmail/acceptance.test.ts` and `src/log.test.ts`
  are byte-unchanged by this pass — the B9-protected suites and the B10 gate were
  not touched, loosened or re-run against a weakened assertion. The only test
  assertion CHANGED (rather than added) anywhere is the one named under `54fe5cf`.
- `git diff 536a9be..HEAD -- src/gmail/auth.ts` still empty; no
  `accounts.json` / `credentials.json` / `tokens/` / `package.json` change; no new
  deps; no push, deploy or `gh` write; no live API call of any kind; no AI
  attribution.

## Remaining — after W5

W6 cold Fable validation. Read the W5 addendum at the end of
`REVIEW-FINDINGS.md` alongside W4's findings.

## W7 — C3 reflow, chair ruling Q2+Q15 (2026-08-27)

W6's validation named exactly one MUST-FIX between the branch and the chair's
live acceptance sends: the chair-ratified reflow fix (Option B) had never been
applied. This unit applies it and nothing else.

- [x] **`reflowPlainText` now classifies the WHOLE PARAGRAPH.** A paragraph
      collapses to one line only when EVERY seam in it passes `canJoin` — every
      line but the last at or over `REFLOW_MIN_JOIN_LEN`, none ending in a colon,
      and no following line a list item, a quote or indented. Any single failing
      seam leaves the paragraph byte-for-byte as authored, instead of joining the
      prefix and breaking at the seam. `canJoin` itself is unchanged (the
      per-line guards are exactly the ones B1c specified); only the unit of
      decision moved from the accumulated line to the paragraph, per the chair's
      amendment of B1c. The `REFLOW_MIN_JOIN_LEN` §A1 evidence comment is
      untouched; the `canJoin` and `reflowPlainText` docstrings state the new
      rule and why.
- **FAIL-before, run at `626523e` with the six new tests added and the
  implementation untouched:** `Tests  4 failed | 415 passed (419)`. The failing
  four are W6's exact repro (`leaves a typed sign-off block verbatim under a long
  line` — output was the single welded line
  `Thanks for sending over the updated appraisal report yesterday afternoon.
  Steve Angelo Appraisal Host 555-1234`), plus `leaves the whole paragraph
  verbatim when an interior line is short`, `lets one vetoed seam block the whole
  paragraph, not just that seam` and `classifies each paragraph independently`.
- **PASS-after:** `npm run typecheck` clean; `npm test` **10 files, 419 tests,
  419 passing** (mime 123, up from 117 — six added, none changed or removed).
- **Preserved deliberately:** the 70-column composer-wrap join (that paragraph
  passes every seam, so it still collapses to one line — first test in the
  suite), idempotence (now true by construction: a reflowed paragraph is one line
  with no seams left, a declined paragraph is unchanged input and classifies the
  same way again — asserted for both cases), and every existing guard test
  (list/quote/indent/colon/threshold), all of which pass unedited.
- **W7 verification:** no baseline or prior-unit test was edited, deleted or
  weakened — `src/gmail/mime.test.ts` gains six `it` blocks and no existing
  assertion changed; `client.test.ts`, `acceptance.test.ts` and `log.test.ts` are
  byte-unchanged by this unit. `git diff 536a9be..HEAD -- src/gmail/auth.ts`
  still empty; no `accounts.json` / `credentials.json` / `tokens/` /
  `package.json` change; no new deps; no push, deploy or `gh` write; no live API
  call; no AI attribution.

## Remaining — after W7

A cold re-check of this unit, then the chair's live acceptance sends (B10.5,
P1 raw-band media upload, P4 non-ASCII recipient display names, C4's 25,000,000
byte attachment). Nothing else from W6's verdict is a code blocker.

## Phase 2 — Units D + E (builder W8, 2026-08-27)

Baseline at `8597ab2`: 419 tests. HEAD: **467 tests**, typecheck clean, 44 tools
registered (was 42).

### Unit D — mail-arrival watcher

- [x] **`c22c353` — the client layer.** `getHistoryBaseline` reads the mailbox's
      current cursor from `users.getProfile`; `getMailChanges` lists what changed
      since a caller-supplied cursor via `users.history.list`. No server-side
      state — the caller owns the cursor. History ids stay STRINGS (live values
      already exceed exact JS number range).
      Two API traps handled explicitly: an expired cursor's 404 becomes a resync
      instruction naming `get_history_baseline`, and `complete` stays false while
      `nextPageToken` is set because the response's `historyId` is the mailbox's
      CURRENT cursor, not the end of the page — storing it mid-pagination skips
      every unread page. Arrivals are hydrated to 100 (`HISTORY_SUMMARY_CAP`),
      the overflow returns in the same shape with empty headers plus a note; a
      message added and deleted in one window is not fetched and stays in
      `deleted`; an arrival that 404s degrades to its history record instead of
      failing the poll. 19 tests.
- [x] **`8381ca0` — the two tools.** `get_history_baseline` and
      `get_mail_changes` registered (42 -> 44). Their descriptions carry the two
      rules a caller cannot infer from the shape: a cursor belongs to ONE account
      and expires after about a week, and the returned cursor is only safe to
      store once `complete` is true. Registration smoke run: 44 tools.

### Unit E — inline images

- [x] **`c09d63e` — `multipart/related` in mime.ts.** The container is built from
      the inside out as Gmail builds it: `alternative` alone, `related
      [alternative, images]` with inline images, `mixed [that, files]` with
      attachments. The cid convention is the file's basename with anything
      outside `[A-Za-z0-9._-]` folded to `_`, so a model that knows the path
      knows the reference with no round trip; two files answering to the same cid
      are refused. Inline images share the 25MB budget; `plain_text_only` refuses
      them. Attachment parts are byte-identical to before. 14 tests.
- [x] **`de811c1` — `inline_images` on the composing tools.** send, draft, reply,
      draft_reply — and `update_draft`, which the contract did not name (filed as
      QUESTIONS item 19: `drafts.update` replaces from the params supplied, so
      without it this unit creates a draft shape `update_draft` cannot
      reproduce). 5 integration tests through the real composition path.
- [x] **`3ed1243` — read side.** `extractAttachments` no longer requires a
      filename: a part counts when it is downloadable AND has a filename or a
      Content-ID, so `cid:` images are listed (with `inline` + `contentId`) and
      `get_attachment` can fetch them. Content-ID rather than the disposition is
      the marker because a large text BODY part also arrives with an
      `attachmentId` and sometimes an inline disposition. `forward_email` now
      re-attaches an inline part AS an inline part with its ORIGINAL Content-ID,
      because the forwarded HTML still references it — the relaxation without
      this would have made every embedded image a broken image plus a stray file.
      **FAIL-before** with the old filter restored: `3 failed | 2 passed` of the
      five new tests. 5 tests.
- [x] **`29e8d1c` — chair ruling Q6, closed on evidence.** The tightening Q6
      asked for (exclude `&` from the terminating class) ALREADY shipped as W5's
      C5 fix at `43d2867`. Verified rather than re-fixed: `&quot;`, `&#39;`,
      `&lt;`, a full stop before a quote, and a query-string `&amp;` all behave
      correctly. Five cases added for the entities C5's own tests did not name.
      **No source change.**
- [x] **`476c38b` — docs.** README 42 -> 44 with the two new rows and the
      `inline_images` param; CHANGELOG 1.5.0; the bundled
      `.claude/commands/email.md` tool table updated.

### W8 verification (2026-08-27)

- `npm run typecheck` clean. `npm test`: **10 files, 467 tests, all passing**
  (baseline after W7 was 419; +48, no pre-existing test edited, weakened or
  removed — `mime.test.ts` and `api.test.ts` gain `it` blocks only, and
  `client.test.ts`, `acceptance.test.ts`, `log.test.ts`, `settings.test.ts`,
  `config.test.ts`, `url-guard.test.ts` and the calendar/docs suites are
  byte-unchanged by this unit).
- Registration smoke run: **44 tools**.
- Prohibitions: `git diff 536a9be..HEAD -- src/gmail/auth.ts` still EMPTY (Units
  D and E need no new scope — `gmail.readonly` already covers `getProfile` and
  `history.list`); no `accounts.json` / `credentials.json` / `tokens/` /
  `package.json` change; no new deps; no push, deploy or `gh` write; no live API
  call of any kind; no AI attribution.
- 6 items filed to `QUESTIONS-FOR-FABLE.md` (19-24). **Items 19 and 20 want a
  look**: two files gained behaviour the addendum did not name, both as
  consequences of the named work rather than scope I went looking for.

## Remaining — after W8

Phase 2 Units F (Drive save, new `drive.file` scope) and G (filters / vacation /
signature swap, new `gmail.settings.basic` scope), then the adversarial pass,
contingent fix pass and cold Fable validation. For the chair's live acceptance:
add one `[TEST]` send with an embedded image — the `multipart/related` structure
is asserted byte-wise but only a real client proves the image renders in the
body rather than as an attachment.

## Phase 2 — Units F + G (builder W9, 2026-08-27)

Baseline at `fe054f8`: 467 tests, 44 tools. HEAD: **519 tests**, typecheck clean,
**50 tools**.

### The scope edit — the one authorized change to `auth.ts`

- [x] **`0a16f26` — `drive.file` + `gmail.settings.basic` added to `SCOPES`.** Exactly
      two entries, which is the whole of the Phase-2 authorization. The docstring above
      the array gained a paragraph naming which tools each scope backs, and its claim
      that the Chat/Drive/Docs grants leave the server read-only "in those services" was
      narrowed to Chat and Docs, because `upload_drive_file` makes it false for Drive. No
      other line of that file changed; `getAuthClient`, the consent flow and
      `checkAuthStatus` are byte-unchanged.
- **The reality this creates:** no stored token carries either scope. Until each alias
  re-consents (`npm run auth -- <alias>`), all six new tools 403. That is not a defect
  to be worked around; it is stated in every new tool's description, in each one's error
  message, in the README setup section and in the CHANGELOG.

### Unit F — Drive save

- [x] **`23fac87` — `upload_drive_file`.** `uploadFile` lives in `src/drive/client.ts`
      alongside the read factory it reuses (`getDriveClient`, unchanged); the module
      header now names the one mutating call and why `drive.file` bounds it. Refusals all
      happen before the network: relative path, empty path, missing path, not a regular
      file, over `MAX_DRIVE_UPLOAD_BYTES` (100,000,000 — decimal MB, matching every other
      ceiling in the codebase). The media body is `fs.createReadStream` created INSIDE the
      retried call, so a retry re-reads the file rather than replaying a consumed stream —
      a 5xx retry can therefore duplicate a file in Drive, which is documented rather than
      hidden. A `name` override is basenamed and control-stripped so it cannot smuggle a
      directory; the content type falls back to the local extension when the override has
      none. Logged like every mutating path: account, file id, folder id, byte count,
      content type — never the local path. 21 tests in the new
      `src/drive/client.test.ts` (stubbed `drive_v3`).
- [x] **`src/scope-error.ts`** (new, shared with Unit G): a 401/403 from a call needing a
      not-yet-granted scope becomes an instruction naming the tool, the scope and the
      exact re-consent command. It recovers the status from BOTH the raw Google error and
      the message `withRetry` rewrites it into, and it re-throws every other failure
      untouched.

### Unit G — mail rules, vacation, signature swap

- [x] **`a660606` — five tools on `users.settings.*`.** `src/gmail/settings-api.ts` is a
      new module, deliberately not `settings.ts`: that one must never fail a send and
      needs no scope, these must fail loudly and all need `gmail.settings.basic`.
      `list_filters` / `create_filter` / `delete_filter` in `src/tools/filters.ts`,
      `get_vacation` / `set_vacation` in `src/tools/vacation.ts` (grouped registration,
      following `star.ts`). 31 tests in `src/gmail/settings-api.test.ts`.
      - **`create_filter` cannot set a forwarding action** — a tool that can would be a
        quiet mailbox-exfiltration path, and forwarding needs a verified address and a
        wider scope anyway. `list_filters` still REPORTS an existing forwarding filter.
      - No-op filters refused (no criteria = matches everything; no label action = does
        nothing), matching the existing no-op refusals on `label_email`, `update_label`,
        `modify_thread` and `batch_modify`.
      - **`set_vacation` fetches and merges** rather than replacing, because Gmail's
        `updateVacation` is a full replace: without it, "turn it off" erases the saved
        message and "change the subject" blanks the body. Same fetch-and-preserve rule as
        the label colour tools. Enabling with no reply text anywhere, an unparseable
        date, or an inverted window are all refused before the write.
      - Enabling is treated as the outward act it is: logged before the call, flags only,
        and the result carries a notice saying what is now switched on.
- [x] **`167c4c5` — the signature-source swap, which is a COMMENT change by design.**
      `getSendAsProfile` keeps its current call, its arguments and its graceful
      degradation exactly as they were; only the module rule that said "do not add
      `gmail.settings.basic`" was rewritten, since that scope is now requested. Making the
      code depend on the new grant would break composition for every alias that has not
      re-consented — and a signature lookup must never be able to fail a send. The 10
      existing settings tests pass untouched.

### W9 verification (2026-08-27)

- `npm run typecheck` clean. `npm test`: **12 files, 519 tests, all passing** (baseline
  after W8 was 467; +52, all in the two NEW test files — no pre-existing test file was
  edited, weakened or removed).
- Registration smoke run: **50 tools**, including all six new ones.
- Prohibitions: `git diff 536a9be..HEAD -- src/gmail/auth.ts` is now NON-EMPTY by
  authorization — it is exactly the two scope entries plus the docstring correction, and
  nothing else in that file moved. No `accounts.json` / `credentials.json` / `tokens/` /
  `package.json` change; no new deps; no push, deploy or `gh` write; **no live Google API
  call of any kind** (none is even possible for these paths until re-consent); no live
  send and no outward state change; no AI attribution.
- The heredoc/control-character trap recorded as QUESTIONS item 13 bit twice during this
  unit and was caught both times by `file <path>` before committing. Worth keeping that
  check in the loop.

## Remaining — after W9

The Phase-2 adversarial opus pass, the contingent fix pass, and cold Fable validation.
Then the **one re-auth round for all five aliases** (BUILD-CONTRACT's closing section),
which is the gate before ANY of the six new tools can be exercised live. For the chair's
live acceptance list, add: one small `upload_drive_file` to Drive root, one `list_filters`
read, one `get_vacation` read — and note that `set_vacation` enabling is an outward act
that should be tested only with an immediate disable, if at all.

## W10 — Phase 2 adversarial first pass (2026-08-27)

Review only; **no source file was modified by this pass**. Findings written to
the ROUND 2 section of
`shared/active-work/2026-08-27-gmail-mcp-upgrade/REVIEW-FINDINGS.md`.

- Fresh run at `d5266f6`: `npm run typecheck` clean; `npm test` **12 files, 519
  tests, 519 passing**. B10 acceptance gate re-run alone: 5 passed. Registration
  smoke: **50 tools, no duplicates** — README's "50 tools" and CHANGELOG 1.6.0
  are accurate. W9's reported counts reproduce exactly.
- **Test integrity across `626523e..HEAD`:** every pre-existing test file is
  additions-only (`mime.test.ts +283/-0`, `api.test.ts +614/-0`), and
  `client.test.ts`, `acceptance.test.ts`, `log.test.ts`, `settings.test.ts`,
  `config.test.ts`, `url-guard.test.ts`, `calendar/client.test.ts` and
  `docs-get-document.test.ts` are byte-unchanged. Zero deleted lines in any test
  file in the range.
- **The SCOPES diff is exactly the two ratified entries** (`drive.file`,
  `gmail.settings.basic`) plus the docstring correction W9 declared as QUESTIONS
  item 25. No executable line of `auth.ts` moved.
- **5 CONFIRMED**, each with an executed reproduction: `set_vacation` writes only
  one body flavour and leaves the other stale, so changing an HTML responder's
  text in plain text does not change what Gmail sends; `forward_email` now throws
  instead of forwarding when a quoted chain repeats a Content-ID; `inline_images`
  with a non-HTML body ships an image nothing references; `withScopeHint` reports
  every 401/403 as a missing grant, including a full Drive and an exhausted rate
  limit; and the ratified Option B reflow declines any paragraph containing a URL
  or other long token (1 of 20 realistic business paragraphs at 70 columns —
  always the URL one).
- **7 PLAUSIBLE** (expired vacation window cannot be cleared; `body: ''` silently
  ignored; the history cursor can move backwards on a future-dated cursor; the
  404-to-resync conversion is `??`-fragile against a string error code;
  `list_filters` drops size criteria; the read-side relaxation changes attachment
  counts for callers outside this repo; the upload size gate is stat-then-stream).
- **12 DROPPED** with evidence, including: the `multipart/related` nesting,
  boundary and cid derivation checked byte-wise; the shared 25MB budget proven;
  Q6's autolink closure independently re-verified; `upload_drive_file`'s path
  refusals and name sanitation exercised; and six history edge cases (empty page,
  label-only page, added-and-deleted, mid-pagination, numeric historyId, both 404
  error shapes) all behaving correctly.
- One design fork filed as QUESTIONS-FOR-FABLE item 32 — whether B1c gets a third
  amendment so a wrap-explained short line stops vetoing its paragraph. Nothing
  is downstream of it.

This is a same-model first pass and is NOT validation. A cold Fable pass should
re-derive the five CONFIRMED findings, and verify R2-C1 against the real API
during the chair's post-re-auth run.

## W11 — Phase 2 fix pass over the ROUND 2 findings (2026-08-27)

Applied four of W10's five CONFIRMED findings and four PLAUSIBLE ones, one
commit each, every one with a FAIL-before demonstration in real vitest output.
Suite went 519 -> 539 tests across 13 files (`src/scope-error.test.ts` is new);
`npm run typecheck` clean at every commit.

| Finding | Commit | What changed |
|---|---|---|
| R2-C1 | `69f4213` | A supplied vacation `body` writes BOTH stored flavours (the named one verbatim, the other derived through `htmlToText`/`textToHtml`), so Gmail's HTML-wins rule can no longer send text the caller replaced. FAIL-before 3 failed / 31 passed. |
| R2-C2 | `38957b6` | `forwardMessage` takes each Content-ID once, first wins, skipping the repeat before its bytes are downloaded. The mime-layer uniqueness check is untouched and still guards the caller-supplied case. FAIL-before 1 failed / 110 passed, throwing the exact uniqueness error with `messages.send` never called. |
| R2-C3 | `2826e1c` | Caller-supplied `inline_images` are refused without `is_html: true`. Forward's own loaded inline parts are unaffected — their cid references live in the quoted block's HTML, not the caller's body. FAIL-before 2 failed / 111 passed. |
| R2-C4 | `4664fca` | `isMissingScopeError` now requires a scope-shaped reason (`insufficientPermissions`, `ACCESS_TOKEN_SCOPE_INSUFFICIENT`, `insufficientScopes`, or the matching phrasing that survives `withRetry`'s rewrite). A full Drive and an exhausted rate limit come through as themselves. `googleErrorReasons` moved from `gmail/client.ts` to `scope-error.ts` — one implementation, in the module that imports nothing. FAIL-before 4 failed / 5 passed. |
| R2-P4 | `042be99` | `historyStatus` is the shared `errorStatus`, so a truthy string in `err.code` cannot swallow the 404-to-resync conversion. |
| R2-P5 | `16e63d0` | `list_filters` reports `size`/`sizeComparison`; a size-only filter no longer reads as "matches everything". |
| R2-P3 | `2bf703a` | The history cursor never moves backwards. A cursor ahead of the mailbox keeps its value and the mismatch goes in the note, instead of silently replaying the window on the next poll. BigInt comparison. |
| R2-P2 | `cca64c1` | A `body` that is supplied but blank is refused rather than read as "no body". |

Docs: `d036479` — README's `set_vacation` note and a CHANGELOG 1.6.1 Fixed
section covering all eight.

**Not applied, deliberately** (full reasoning as QUESTIONS items 33-35):

- **R2-C5** (Option B reflow declines any paragraph containing a long token) —
  a third amendment to B1c, which the chair ratified. QUESTIONS item 32 carried
  no ruling when this pass opened and none when it closed; the file was re-read
  at both ends. Nothing is downstream of it.
- **R2-P1** (an expired vacation window cannot be cleared) — needs a parameter
  affordance the tool does not have, so it is a design call, not a repair.
- **R2-P6** (read-side attachment counts, workspace-level callers) — the chair's
  pre-merge sweep, with items 8 and 30.
- **R2-P7** (stat-then-stream upload gate) — an honest trade, documented at the
  call site.
- **W4's P10** (`withRetry` misreports a Calendar 403) — same class as R2-C4 and
  now divergent from it; still item 17, still wants a ruling.

**One existing assertion was restated, not added:** `settings-api.test.ts`
pinned `responseBodyPlainText` as undefined after an HTML write, which is R2-C1
itself. Declared as QUESTIONS item 34. Every other test change in this pass is
an addition.

**Prohibitions honored:** no AI attribution; no push, deploy or `gh` write; no
change to `accounts.json`, `credentials.json`, `tokens/`, `package.json` or the
lockfile; no new dependency; `src/gmail/auth.ts` untouched by this pass; no live
Google API call of any kind.

## Remaining — after W11

Cold Fable validation of the whole Phase-2 range, a ruling on QUESTIONS item 32
(reflow) and item 17 (P10), then the one re-auth round for all five aliases
before any of the six new tools can be exercised live. R2-C1's severity and
R2-C2's trigger both want confirming against the real API in that post-re-auth
run.

### Superseded — the remaining list as it stood after W10

The contingent Phase-2 fix pass, then cold Fable validation, then the one
re-auth round for all five aliases before any of the six new tools can be
exercised live. (The fix pass is W11 above.)

## W12 — cold Fable validation, final round (2026-08-27)

Verdict: **VALIDATED, empty must-fix list** — written to
`shared/active-work/2026-08-27-gmail-mcp-upgrade/VALIDATION-VERDICT-2.md`.
Against artifacts at `cf4f445`: fresh run (typecheck clean; 13 files, 539/539),
the chair-ordered C3 re-check executed independently (sign-off block verbatim at
HEAD, 70-col wrap joins to one line, FAIL-before re-run at `626523e` → exactly
4 failed / 415 passed), Phase-2 D/E/F/G re-derived from the addendum item by
item, test diff over `626523e..HEAD` pure-additions-or-untouched (zero deleted
lines; W11's one restated assertion inspected and legitimate), SCOPES diff
exactly the two ratified entries + comments, own attack batteries against
`upload_drive_file` paths and the autolinker (no finding), ROUND 2 findings
re-judged with one round-2 FAIL-before spot-checked in history (3/31 at
`69f4213~1`). No source file modified, no live API call. Three open chair
rulings remain (items 32/33, R2-P1, item 17/P10 — none blocks acceptance); the
definitive live-acceptance checklist, including round 1's P1/P4/C4 carryovers,
is in the verdict file.

## Remaining — after W12

The chair's: three open rulings, the one re-auth round for all five aliases,
the live-acceptance checklist in VALIDATION-VERDICT-2.md, the cross-repo shape
sweep, then Steve's merge/push decision.

## W13 — final fixes (2026-08-27)

Three fixes, one commit each, every one with a FAIL-before run recorded against
HEAD before the fix landed. Baseline at `353cc25` was 539 tests across 13 files;
HEAD is **578**, typecheck clean, **50 tools** registered (unchanged).

- [x] **`ad84625` — non-ASCII recipient display names (acceptance P4).** New
      `encodeAddressList` in `mime.ts` splits `to`/`cc`/`bcc` on the commas that
      actually separate mailboxes — respecting quoted display names
      (`"Angelo, Steve" <a@b.c>`) and angle-addrs — and RFC 2047-encodes ONLY the
      display-name half, only when that name is itself non-ASCII. The angle-addr
      is never rewritten. Two rules hold the delivery risk at zero: a pure-ASCII
      list returns byte-identical BEFORE any parsing happens (so every existing
      send emits exactly the header it emitted before), and an already-encoded
      word, a bare address, an ASCII quoted-string or a non-ASCII bare address
      passes through verbatim even when a sibling mailbox needs encoding. The
      module already had an `isAscii` helper; it is reused rather than
      duplicated. **FAIL-before at HEAD: `6 failed | 145 passed (151)` in
      `mime.test.ts`** (the To header carrying raw `José <j@x.com>`).
      PASS-after: full suite 555. 16 tests added.
- [x] **`fa6d6dd` — Calendar 403 honesty (chair-queued item 17 / W4-P10).**
      `translateCalendarError` threads a per-call context (tool + the scope THAT
      call needs) through all four calendar call sites. A missing scope becomes
      the shared `scopeError` — same instruction the six Phase-2 tools produce;
      an `accessNotConfigured` 403 says to enable the API in the Cloud console
      and states that re-authenticating will not help; a rate-limit 403 is
      returned UNTOUCHED so `withRetry` still retries it and Google's own words
      reach the caller; every other status, 401 included, propagates unchanged.
      The translation runs INSIDE `withRetry` because the reason codes that tell
      these cases apart do not survive its rewrite. `isRateLimit403` is exported
      from `gmail/client.ts` (a one-word change, no behaviour) rather than
      duplicating its reason set. **FAIL-before at HEAD: `6 failed | 38 passed
      (44)`**, the failures reading `Authentication error (403): Google Calendar
      API has not been used in project 12345…`. PASS-after: full suite 566.
      11 tests added.
- [x] **`25bac29` — vacation-responder enable guards** (today's live incident: a
      2016 saved responder re-enabled by something outside this tooling). Both
      guards run before the `log()` line and before the write:
      - **stale window** — `updateVacation` merges, so "turn it on" with no
        window supplied restores whatever start/end was saved. When the MERGED
        `endTime` is in the past the call is refused, naming the dates it found
        and asking for the window the caller means. A fresh `end_time` proceeds.
      - **confirm** — `enable: true` is refused without `confirm: true`, a new
        optional field on `SetVacationOptions` and on the tool schema. `enable`
        alone is a value a model can produce while paraphrasing a question; the
        consequence is the account auto-replying to everyone who writes in.
      `enable: false` needs neither guard. Tool description states both rules.
      **FAIL-before at HEAD: `6 failed | 42 passed (48)` in
      `settings-api.test.ts`**, plus `tsc` rejecting `confirm` as unknown on
      `SetVacationOptions`. PASS-after: full suite 578. 12 tests added.
- [x] **`815fee0` — docs.** README `set_vacation` row + a rewritten
      enabling note, a new Calendar permission-errors note; CHANGELOG 1.6.2
      (two Fixed, one Changed); the bundled `.claude/commands/email.md`
      `set_vacation` row carries `confirm?` and both rules.

### W13 test integrity — one declared restatement

`src/gmail/mime.test.ts` (+176/-0) and `src/calendar/client.test.ts` (+132/-0)
are pure additions. `src/gmail/settings-api.test.ts` is +139/-8: **nine
pre-existing enable-path tests were RESTATED, not loosened** — each gained
`confirm: true` at its call site, because the contract now requires it. Every
deletion in that diff is one of those ten call lines; no assertion changed, no
test was removed, and the two refusal tests it touches (`refuses to enable with
no body anywhere`, `refuses an inverted window`) still assert their own original
refusal. `client.test.ts`, `acceptance.test.ts`, `log.test.ts`,
`settings.test.ts`, `config.test.ts`, `url-guard.test.ts`, `api.test.ts`,
`scope-error.test.ts`, `drive/client.test.ts` and `docs-get-document.test.ts`
are byte-unchanged by this unit. The five B10 acceptance gates still pass.

### W13 verification

- `npm run typecheck` clean and `npm test` green at EVERY commit in the range
  (539 → 555 → 566 → 578).
- Registration smoke run: **50 tools**, `set_vacation` present.
- Prohibitions honored: no AI attribution; no push, deploy or `gh` write; no
  change to `accounts.json`, `credentials.json`, `tokens/`, `package.json` or
  the lockfile; no new dependency; `src/gmail/auth.ts` untouched by this pass
  (`git diff 353cc25..HEAD -- src/gmail/auth.ts` empty) and SCOPES unedited; **no
  live Google API call of any kind, no live send and no live settings write** —
  every test runs against the stubbed clients.

### Note for the chair

The chair's ROUND 2 ruling parked R2-P1 (stale vacation window) as "LEAVE AS
SHIPPED … queue the refuse-if-past guard as a polish item if vacation tooling
gets real use". Today's incident is that trigger, and this unit's task named the
guard explicitly, so it is now applied. `Reply-To` is the one remaining address
header whose display name is not RFC 2047-encoded; the task scoped fix 1 to
`To`/`Cc`/`Bcc`, so it was left alone rather than widened unasked.

## Remaining — after W13

Unchanged from W12, minus item 17 (now fixed): the chair's re-auth round for all
five aliases, the live-acceptance checklist in `VALIDATION-VERDICT-2.md`, the
cross-repo shape sweep, then Steve's merge/push decision. Two live checks to add
to that list: one `[TEST]` send to a non-ASCII display name (fix 1 is asserted
byte-wise but only a real client proves the name renders), and — only if the
chair wants it — a `set_vacation` enable/disable pair to confirm the two new
refusals fire against the real API.
