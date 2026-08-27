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

## Remaining — after W4

W5 fix pass on the confirmed findings (reflow gated on QUESTIONS item 15), then
W6 cold validation.
