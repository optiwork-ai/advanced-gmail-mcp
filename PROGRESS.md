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
