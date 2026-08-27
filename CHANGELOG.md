# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] — 2026-08-27

### Changed
- **Outbound mail is now `multipart/alternative` by default.** Every message sent, drafted, replied or forwarded carries a `text/plain` part AND a Gmail-shaped `text/html` part. **`is_html` now selects how your `body` is interpreted, not what container is sent** — `is_html: true` still means "my body is HTML" and now also gets a generated plain-text alternative; leaving it unset still means "my body is plain text" and now also gets a generated HTML alternative. Existing callers keep working and render better.
- **Every part is base64 `Content-Transfer-Encoding` at 76 characters**, and long headers fold at column 78. This retires the RFC 5322 998-octet line limit, which any HTML body or long `References` chain crossed trivially.
- **Reply-all now matches Gmail**: the original `To` recipients go in `To` and the original `Cc` in `Cc`, both minus your own address. They previously all went to `Cc`.
- **`resolveAccount` no longer substring-matches an email address.** An exact alias or an exact email only (case-insensitive). A near-miss now errors with the list of valid aliases instead of silently picking whichever account contained the text. A missing default alias throws a named config error.
- **`forward_email` re-attaches the original's attachments** by default (`include_attachments: false` opts out) and uses Gmail's own forwarded-message block, separator and date shape.

### Added
- **Gmail signature and sender display name.** Outbound mail picks up the account's `sendAs` display name (`Steve <steve@…>` rather than a bare address) and appends its Gmail signature, in Gmail's own wrapper. `include_signature: false` opts out per call. No new OAuth scopes and no re-consent: `sendAs.list` works on the tokens already on disk, and any failure degrades to no signature rather than failing the send.
- **Quoted history on replies** — the `gmail_quote` container, blockquote and `On <date> <sender> wrote:` attribution Gmail itself emits, in both HTML and text flavours. `include_quote: false` opts out.
- **Attachments** — new `attachments` parameter (absolute file paths) on `send_email`, `draft_email`, `reply_email` and `draft_reply`. 25MB per file and in total; messages over 5MB are sent through the media-upload transport.
- **A deterministic reflow pass** that undoes composer hard-wrapping (paragraphs wrapped at ~70 columns became visible line breaks in the recipient's inbox) while preserving blank lines, list items, quoted lines, indented blocks and lead-in lines. The composing tools' `body` descriptions now state the newline contract explicitly.
- **`src/gmail/mime.ts`** — all MIME assembly, text/HTML conversion, reflow, quote and forward blocks, header folding and attachment loading, with ~95 unit tests. **`src/gmail/settings.ts`** — the cached `sendAs` lookup.

### Fixed
- **Header injection.** CR and LF are stripped from every caller-supplied header value (`to`, `cc`, `bcc`, `from`, `subject`, `reply_to`). A recipient of `a@b.com\r\nBcc: evil@x.com` previously minted a real `Bcc` header and silently blind-copied it.
- **`Reply-To` was ignored on replies.** Replying to any sender that sets `Reply-To` (ticketing systems, marketing platforms, mailing lists) sent the reply to the wrong address.
- **`extractBody` was last-wins** and descended into `message/rfc822` sub-messages, so a message containing a forwarded original could report the nested original as its own body.
- **A 404 when replying** now names the account the message was looked for in, instead of surfacing a raw Gmail error.

## [Unreleased]

### Added
- **Read-only Google Chat tools** — `list_chat_spaces`, `list_chat_messages` (per-space, paginated), `get_chat_message`.
- **Read-only Google Drive tools** — `search_drive_files` (Drive `q` query syntax, paginated) and `read_drive_file` (metadata + text; Google Docs/Sheets/Slides exported to text/plain|text/csv, other text files read via `alt=media`, binary/unknown types return metadata only, ~1MB content cap with truncation flag).
- **Read-only Google Docs tool** — `get_google_doc` flattens a document's paragraphs and tables into plain text.
- **4 new OAuth scopes** (additive, read-only): `chat.spaces.readonly`, `chat.messages.readonly`, `drive.readonly`, `documents.readonly`. Existing tokens keep working; each alias must be re-consented via the auth flow to gain the new scopes, and the Chat/Drive/Docs APIs must be enabled in Google Cloud.
- **Service-client factories** — `src/chat/client.ts`, `src/drive/client.ts`, `src/docs/client.ts`, each reusing the shared OAuth client + per-account token store, mirroring the Gmail client cache.

## [1.1.0] — 2026-05-19

### Added
- **`unsubscribe_email` tool** — processes RFC 2369 `List-Unsubscribe` + RFC 8058 `List-Unsubscribe-Post` headers. Prefers one-click HTTPS POST (10s timeout, tries every URL in the header) and falls back to mailto.
- **`mark_read` / `mark_unread`** — toggle the UNREAD label.
- **`star_email` / `unstar_email`** — toggle the STARRED label.
- **`mark_important` / `mark_not_important`** — toggle the IMPORTANT label.
- **`get_attachment`** — fetch the raw bytes of an attachment by `attachmentId` (base64-encoded).
- **`list_drafts`** — enumerate drafts with id + headers.
- **`read_draft`** — read a draft's full content by id.
- **`forward_email`** — forward an existing email to new recipients (text/HTML body; original attachments are NOT re-attached).
- **`create_label` / `update_label` / `delete_label`** — manage the label catalog (rename, recolor, delete).
- **Server-side logging** — JSON-lines log to `~/.cache/gmail-mcp/server.log`. Configurable via `GMAIL_MCP_LOG_PATH` and `GMAIL_MCP_LOG_DISABLE` env vars.
- **CI workflow** — `.github/workflows/ci.yml` runs typecheck + unit tests on every push and PR (Node 20.x and 22.x).
- **`scripts/smoke.ts`** — CLI smoke-test harness for exercising client functions against real Gmail accounts.
- **Vitest** — 50+ unit tests covering pure helpers (`parseUnsubscribeHeaders`, `withRetry`, reply/forward/encoding helpers).
- **`AttachmentInfo.attachmentId`** — exposed on `read_email` results so agents can fetch attachment bytes.
- **`EmailFull.list_unsubscribe` and `list_unsubscribe_post`** — exposed on `read_email`.

### Changed
- **`list_emails` and `search_emails` are now parallelized** — message metadata fetches run 10 in parallel; 100-message list dropped from ~20s to ~3.2s end-to-end.
- **`withRetry` now retries on 5xx (500, 502, 503, 504)** in addition to 429. Exponential backoff (1s, 2s, 4s). Exported with an injectable `sleep` for testability.
- **`buildRawMessage` encodes non-ASCII subjects as RFC 2047 encoded-words** so emoji and accented characters survive headers.
- **Reply/draft-reply share a single `prepareReply`** implementation; threading logic (subject, references chain, reply-all CC dedup) is now in pure helpers.

### Fixed
- Stale alias hint in `draft_reply` / `send_draft` parameter descriptions ("vyg, indigo, personal, abacus" — none of which actually exist in `accounts.json`).
- Silent error swallow in the HTTPS unsubscribe path — HTTPS POST failures are now surfaced in the result `detail` instead of falling through silently to mailto.

### Deferred
- **`permanent_delete`** — would require expanding OAuth scope to `https://mail.google.com/`, forcing all configured accounts to re-authenticate. Not shipped; `trash_email` remains the deletion path.

## [1.0.0] — 2026-04-03

Initial release. 12 tools across read / compose / modify categories with multi-account OAuth2 support, token auto-refresh, and rate-limit retry.
