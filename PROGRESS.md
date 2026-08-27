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

## Remaining — Unit B
- [ ] Item 4 — correctness repairs (#6, #16, #7, #11, #8, #9/#26/#19, #12, #13/#14, #18,
      #17, #10, #21, #1 SSRF, #27 logging)
- [ ] Item 5 — README/CHANGELOG

## How to resume

`git log 536a9be..HEAD` for what landed. `npm run typecheck && npm test` from the repo
root. B10.5 (live sends) is the chair's, not a builder's.
