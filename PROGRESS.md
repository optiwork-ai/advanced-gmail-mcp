# PROGRESS — feat/gmail-native-outbound (base 536a9be)

Unit A of `shared/active-work/2026-08-27-gmail-mcp-upgrade/BUILD-CONTRACT.md`
(= `review-outbound.md` PART B, B0-B10, plus the two security items the contract
adds: CRLF/header-injection sanitation and `resolveAccount` hardening).

## Done

- [x] **B10 acceptance gate written FIRST, demonstrated failing** — `src/gmail/acceptance.test.ts`
      (5 gates: multipart/alternative + 998-octet guard, quote block, From display name,
      two CRLF header-injection gates). FAIL-before run recorded: 5/5 failed against the
      old single-part builder. `buildRawMessage` exported and `MimeOptions` given the new
      optional suffix fields so the gate compiles; `src/gmail/mime.ts` stubbed.

## Remaining

- [ ] B1 `mime.ts` — normalizeNewlines, escapeHtml, header sanitation, foldHeader,
      reflowPlainText, textToHtml, htmlToText, buildMimeMessage
- [ ] B2 quote block + formatGmailDate
- [ ] B3 `settings.ts` sendAs profile (cached, never inside withRetry)
- [ ] B4 attachments + size gates + media transport
- [ ] B5 forward rebuild
- [ ] `client.ts` rewrite: buildRawMessage, prepareReply, buildReplyRecipients,
      extractBody first-wins (F5), dispatch helpers
- [ ] `resolveAccount` hardening (`src/config.ts`)
- [ ] B6 tool params/descriptions (5 files)
- [ ] B7 docs (README, CHANGELOG)
- [ ] B8 tests (mime.test.ts, settings.test.ts, client.test.ts extension)
- [ ] B10 PASS-after run

## How to resume

`git log 536a9be..HEAD` for what landed. `npm run typecheck && npm test` from the repo
root. B10.5 (live sends) is the chair's, not a builder's.
