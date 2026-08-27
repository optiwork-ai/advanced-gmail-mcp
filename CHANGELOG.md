# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.4.1] — 2026-08-27

### Fixed
- **Unsubscribe SSRF: the URL guard judged IPv6 addresses by spelling.** `::ffff:7f00:1` is `::ffff:127.0.0.1` written in hex, and hex is what Node's resolver returns for a bracketed IPv4-mapped literal — so `https://[::ffff:127.0.0.1]/…` in a `List-Unsubscribe` header was allowed end to end. Addresses are now expanded to their 16 bytes before any judgement, and IPv4-mapped, IPv4-translated, IPv4-compatible, NAT64, 6to4 and Teredo forms are all covered.
- **A long non-ASCII header could exceed the 998-octet line limit.** A 400-character accented subject produced a 1,097-octet `Subject:` line, because the whole value was emitted as one unsplittable RFC 2047 encoded-word. Long values now become several encoded-words, which fold normally.
- **The advertised 25MB attachment allowance was unreachable.** The attachment budget was measured in MiB while the message ceiling was decimal MB, so a 25MB attachment died at the ceiling with "Assembled message is 34.2MB, over the 35MB ceiling". Every ceiling is now decimal MB, and the full 25MB fits.
- **Autolinking ran through HTML entities.** `Visit "https://example.com" for details` produced a link whose href ended in `&quot` with a stray `;` outside it. A legitimate `&` in a query string still stays inside the link.
- **`plain_text_only` silently discarded attachments** and skipped the size gate. It is now a refusal.
- **`htmlToText`** no longer ends an anchor tag at a `>` inside a quoted attribute value, and its internal placeholder can no longer be forged by the source document.
- **An attachment's content type is validated** as a MIME token instead of only being CR/LF-stripped, and non-ASCII filenames are fully percent-encoded per RFC 2231.
- **A failed signature/display-name lookup is no longer cached for 50 minutes.** One transient error used to strip the signature and display name from every message sent for the rest of the window; a failure is now retried after a minute.
- **`create_calendar_event` refuses an inverted or zero-length time range** before calling the API, the way `get_freebusy` already did.

## [1.4.0] — 2026-08-27

### Added
- **Google Calendar tools (4)**, bringing the roster to 42:
  - `list_calendars` — the calendars the account can see, with id, summary, timeZone, accessRole and which one is primary. Read-only.
  - `list_calendar_events` — events on a calendar, with recurring events expanded into their instances and returned in start-time order. Optional `time_min` / `time_max` / `query`; 50 per page, ceiling 250, `page_token` for the rest. Read-only.
  - `get_freebusy` — busy intervals across one or more calendars in a time window. A calendar the account cannot read comes back with an `errors` entry rather than failing the whole query. Read-only.
  - `create_calendar_event` — the only Calendar tool that writes.
- **`create_calendar_event` will not email anyone by default.** `send_updates` defaults to `"none"`; adding attendees puts the event on their calendar without sending mail. `"all"` makes Google email every attendee an invitation — an outward-facing act — and the parameter description says so plainly. Every created event returns a `notice` stating which happened, and the creation is logged with account, calendar id, event id, attendee count and the `send_updates` value — never attendee addresses or the event body.
- **`create_calendar_event` refuses ambiguous times rather than guessing.** A date-only `start` for a timed event errors with an instruction to pass a full timestamp or set `all_day`; a timestamp passed with `all_day: true` errors the other way. The all-day end date is documented as exclusive, as Google defines it.

### Notes
- No new scopes: the Calendar scopes have been in the requested set since 2026-05-20. An alias whose token predates that grant must be re-authenticated (`npm run auth -- <alias>`) before the Calendar tools work.
- The Google Calendar API must be enabled on the Cloud project; the README setup steps now say so.

## [1.3.0] — 2026-08-27

### Added
- **Thread-level operations** — `modify_thread` (add/remove label IDs on every message in a conversation; archive by removing `INBOX`) and `trash_thread`. Archiving a single message left the rest of the thread in the inbox, which is not what "archive this conversation" means.
- **Draft editing** — `update_draft` (replaces a draft's contents through the same Gmail-native composition path as `draft_email`, preserving the draft's `threadId`) and `delete_draft` (permanent, and its description says so).
- **`get_attachment` now takes `save_dir`** — an absolute directory path. The bytes are written to a file instead of being inlined; the filename comes from the message part (sanitized against path traversal), an existing file is never overwritten, and the result carries `path`, `filename`, `mimeType` and `size`.
- **`get_labels` takes `include_counts`** (default `false`) to fetch `messagesTotal`/`messagesUnread` per label.
- **`page_token` on `list_emails`, `search_emails` and `list_drafts`**, which now return `{ messages | drafts, nextPageToken }`.
- **`order_by` on `list_chat_messages`**, defaulting to `createTime desc`.

### Changed
- **`list_emails` and `search_emails` default to 50 results, not 500.** An unparameterized call previously issued ~501 API round trips (one `messages.get` per message) and returned 500 objects. The ceiling is now 500 per page, with `page_token` for the rest.
- **`get_attachment` will not inline more than 1MB.** A larger attachment errors with an instruction to pass `save_dir`, and is refused before the download rather than after. A 25MB attachment used to become ~34MB of base64 in the model's context.
- **`batch_modify` returns what actually succeeded.** The tool used to synthesize `success: true` from its own input array and discard the client's result; a partial failure is now visible, with the failing IDs listed.
- **`read_email` with `format: "metadata"` or `"minimal"`** returns a headers-only shape with an explicit `body_note` instead of a full-shaped email whose body was silently empty.
- **`create_label` refuses one colour without the other** rather than inventing `#000000`/`#ffffff`, and **`update_label` preserves the colour half you omit** by reading the label first — its "omit to keep existing" promise is now true. `update_label` also enforces its stated "at least one of name/text_color/background_color" rule, as `label_email` does for `add_labels`/`remove_labels`.

### Fixed
- **SSRF in `unsubscribe_email`.** The one-click POST took its target from the attacker-supplied `List-Unsubscribe` header with no host check and a scheme regex that admitted plain `http`. It now requires `https`, resolves the hostname and refuses any private, loopback, link-local, CGNAT, benchmarking, documentation, multicast or reserved address (IPv4 and IPv6), and never follows redirects. A refused URL falls through to the mailto path with the reason reported.
- **Rate-limit 403s are retried, not mislabelled.** Gmail answers 403 for `rateLimitExceeded`/`userRateLimitExceeded` as well as for real authorization failures; every 403 was being rewritten into a fatal "re-authenticate" instruction.
- **`batchModify` is chunked at Gmail's 1000-ID limit**, and batch trash continues past a failure with per-ID results instead of a serial loop that discarded the record of everything already trashed.
- **`get_thread` no longer returns empty bodies for HTML-only messages** (it falls back to the flattened HTML) and now includes per-message attachment metadata.
- **`get_labels` no longer reports `0` counts it never fetched.** `labels.list` does not return them; the fields are absent unless real.
- **`get_attachment` restores base64 padding.** The old base64url conversion dropped the `=`, so strict decoders rejected output the description promised was directly decodable.
- **`list_drafts` paginates**, like every other list tool.
- **Google Doc tables no longer collapse into one line** — table rows were joined with the empty string.
- **`read_drive_file` states what its exports lose** — a Sheets CSV export returns only the first sheet, and a Slides text export drops speaker notes; both are now declared in `contentNote`.
- **Destructive calls are logged.** Send, reply, forward, send draft, trash message, trash thread, modify thread, delete draft, delete label, batch trash and both unsubscribe paths record the action, account alias and target ID. Bodies and addresses are never logged.

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
