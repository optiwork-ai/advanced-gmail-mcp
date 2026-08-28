# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.7.0] — 2026-08-28

### Added
- **You can now look at an image someone emailed you.** A PNG, JPEG, GIF or WebP fetched with `get_attachment` comes back as a viewable image rather than a filename and a size, so a screenshot, a photo of a damaged roof or a scanned form can be read and answered about in the same breath as the email it arrived on. Files written to disk with `save_dir`, and every other file type, are unchanged. The 1MB inline limit still applies, and formats no client is required to render (SVG, TIFF, HEIC) still come back as data rather than risking a rejected call.
- **Drive search now finds files in shared (team) drives.** They were invisible, with nothing saying so — an empty result reads exactly like "that file does not exist". My Drive and every shared drive the account can see are now searched together; `include_shared_drives: false` narrows it back. Results carry `driveId` so a shared-drive hit can be told apart. No new permission is needed.

- **`update_google_doc` (1 tool), the first write this server makes to a Google Doc**, bringing the roster to 51. It does two things and refuses to do more: add text at the end of a document, and replace text you can name, everywhere it appears. Both in one call if you like — the replacements run first, so text you add is not rewritten by them.
  - **No inserting at a position, deliberately.** The Docs API addresses everything by character offset, and an offset is a number in a document the caller cannot see: one wrong by two rewrites the wrong paragraph, silently and with nothing to show for it. Anything that surgical belongs in Docs itself, where the person doing it can see what they are changing.
  - **A replacement that matched nothing is called out.** Google reports success either way, so without this the tool would say the document had been edited when it had not.
  - **This is a real edit to a real document**, immediate, with Google Docs' own version history as the only way back. The tool says so first.
- **The `documents` permission replaces `documents.readonly`, and every account must re-consent.** It covers reading as well, so both Docs tools now travel on the one grant — but until an alias runs `npm run auth -- <alias>` again, **`get_google_doc` and `update_google_doc` both answer 403**, and both say exactly that rather than reporting a broken login. Nothing else is affected.

- **The mail watcher remembers where it got to.** Asking "what has arrived since last time?" no longer means keeping a bookmark yourself: `get_mail_changes` called with no cursor continues from where that account was last read to. A session that forgets, or a scheduled job that restarts, picks up exactly where the last one stopped instead of starting blind. The first poll on an account still needs one cursor from `get_history_baseline`; after that it is remembered, per account, on this machine.
  - **The bookmark only moves forward, and only on a complete read.** It is never moved while pages are still unread, because that would skip the mail in them, and a position behind the one already stored is refused rather than replayed as new mail.
  - **Passing your own cursor still works exactly as it did**, and always wins over the remembered one. Remembering is a default, not a lock.

### Changed
- **Unsubscribing can no longer send an email on its own.** Most lists offer a one-click link, which sends no mail and is unchanged. When a list offers no working link, the only way to unsubscribe is to send a message from your account — and "check that email's unsubscribe header" is a request that could satisfy itself that way without anyone meaning to. That send now requires an explicit confirmation, and the refusal names the exact recipient, subject and body it would have sent so you can agree to a real thing.
- **An email with no unsubscribe link is no longer reported as a failure.** There is nothing to unsubscribe from, nothing was sent, nothing changed — so Claude stops retrying and apologising for ordinary mail. A header that genuinely cannot be read is still a failure.
- **Deleting a label now enforces the confirmation it always claimed to require.** The tool has read "confirm with the user first — there is no undo" since it was written, and nothing checked it. Deleting a label strips it from every message it was on, and that labelling work does not come back.
- **The Chat and Drive lists return the fields they promise instead of the whole raw Google object.** Every Chat listing was carrying its parent space repeated in full on each message, plus card payloads, reaction summaries and three duplicate copies of each message's text — most of the size of the call, for fields nobody asked for, while the description named four. Attachments are kept (reduced to name and type), so "here's the report" never looks like a message with nothing attached, and a card-only alert keeps its fallback text rather than arriving blank.

### Fixed
- **A permission error from Chat, Drive search or Docs told you to log in again when that was not the problem.** The real causes are a permission never granted, an API never switched on for the Cloud project, or a file the account simply cannot see — none of them fixed by re-authenticating, which sent you round a loop while the true cause survived only in a tail of the message. Each now names what is actually wrong and what fixes it. A 401, where logging in again really is the answer, is untouched.
- **Reading one very large Google Doc or Sheet could spike the server's memory.** Drive's export cannot be asked for fewer bytes, so a 50MB document was fetched whole before being trimmed to the 1MB the tool returns — inside a process every account shares. The read now stops at the cap and ends the transfer there. Nothing changes for a normal-sized file. A document cut at the cap also no longer ends in a broken half-character.
- **Your own name went out as gibberish if it has an accent in it.** Recipient names were fixed in 1.6.2; the `From` and `Reply-To` names were not, and both are filled from your Gmail profile — so an account whose display name carries an accent was garbling it on every message it sent. Plain-ASCII names are byte-for-byte unchanged.
- **The activity log recorded intentions, not outcomes.** Every destructive action — trashing a message or a thread, emptying a batch, deleting a label or a draft, sending a draft — wrote its line to the log *before* calling Google and nothing afterwards, so an action that failed still left a record saying it had happened. Each now logs how it ended as well, with the reason when it failed. Anyone reading the trail later, including a future session working out what the mailbox did, can trust it.
- **The two Chat tools accepted different id formats from each other.** `list_chat_messages` took a bare space id or a full name; `get_chat_message` took only the full name, so handing it the id its sibling had just accepted failed with a raw Google error about a malformed name. Both now accept both, and a bare message id — which genuinely cannot identify a message, because a message belongs to a space — is refused with a sentence saying so and where to get the right name.
- **Reading a broken draft said only "has no underlying message".** A draft that exists as an empty shell now explains what that state is and what to do about it.
- **The package claimed to be version 1.1.0** after six releases, and a stale April build sat in `dist/` looking like the code that runs. The version is honest again, the build script is gone (the server runs from source; `tsc` now writes nothing), and `dist/` is documented as deletable.

## [1.6.2] — 2026-08-27

### Fixed
- **A recipient name with an accent in it went out as gibberish.** `To: José Müller <steve@optiwork.ai>` was written into the header as raw 8-bit bytes, which the mail standard forbids, so the recipient's name arrived mangled. Names in `to`, `cc` and `bcc` are now encoded the same way the subject line already was — and only the name half: the address itself is never rewritten, and a list made entirely of plain ASCII goes out byte-for-byte as it did before. A name containing a comma (`"Angelo, Steve" <a@b.c>`) is still one recipient, not two.
- **A Calendar permission error told you to re-authenticate when that was not the problem.** The retry helper is shared with Gmail, where a 403 usually is a token problem; for Calendar the two common ones are "the Google Calendar API was never switched on for this project" and "this account was never granted the calendar permissions" — neither fixed by logging in again, and the real cause survived only in a tail of the message. Each now says what it actually is: the missing permission is named along with the exact command that grants it, the switched-off API points at the Cloud console and says re-authenticating will not help, and a rate limit reports itself as a rate limit.

### Changed
- **Turning the vacation responder ON now takes an explicit confirmation, and refuses a stale window.** A responder saved in 2016 was found switched back on by something outside this server. Two guards close that door here: `set_vacation` refuses `enable: true` unless `confirm: true` is passed with it — enabling makes the account send mail outward on its own, and one flag cannot be reached without the user having actually asked for it — and it refuses to enable a responder whose saved end date has already passed, naming the dates it found and asking for the window you actually mean. **Turning the responder OFF is unchanged and needs neither**: the safe direction is never harder than the dangerous one.

## [1.6.1] — 2026-08-27

### Fixed
- **`set_vacation` could report success while the auto-reply Gmail actually sends stayed the same.** Gmail keeps the out-of-office message in two forms, plain text and HTML, and sends the HTML one when both exist. Only the form the caller named was written, so changing the message of an HTML responder — which is what Gmail's own web UI writes — with a plain `body` returned success, echoed the new text, and left the account replying with the old one. A supplied `body` now rewrites both forms from what was passed, so they cannot disagree. Omitting `body` still keeps everything saved. A `body` that is supplied but blank is now refused instead of being read as "no body at all".
- **`forward_email` refused to send a chain that repeated an embedded image.** A quoted Outlook or Gmail thread carries its signature logo at every level under one reference, and the second copy tripped the duplicate-reference check — a message that used to forward fine came back as an error telling the caller to rename a file they never named. Repeats are now taken once. Two genuinely different files sharing a reference are still refused.
- **`inline_images` without `is_html` shipped a picture nothing pointed at.** The parameter always said it needed an HTML body and nothing enforced it, so the image rode along in a message whose body could not reference it, and the tool reported success. It is now refused, the way `plain_text_only` already refused it.
- **Every permission error from the six newest tools claimed the account was missing a grant** — including "your Drive is full" and a rate limit that outlasted the retries. The real cause survived only in a tail after "Original error:". The re-consent message now fires only when Google actually says the token's scopes were insufficient; everything else comes through as itself. That message is right today for almost every failure, and would have become wrong for all of them the moment the accounts re-consent.
- **`get_mail_changes` could hand back a cursor older than the one it was given.** A cursor from another mailbox is ahead of this one, and Gmail answers that with its own smaller position — which the tool returned as "store this", so the next poll replayed a window already seen, silently. The cursor now only moves forward, and the mismatch is reported instead. Separately, an expired cursor is recognised as expired even when the underlying client puts a word rather than a number in the error's code field.
- **`list_filters` described a size-based filter as matching everything.** Gmail lets a rule match on message size; those two fields were dropped from the summary, so a size-only filter came back with empty criteria. They are now reported. `create_filter` still cannot set them.

## [1.6.0] — 2026-08-27

### Added
- **Drive upload (1 tool)** and **mailbox settings (5 tools)**, bringing the roster to 50:
  - `upload_drive_file` — a local file goes to Drive and comes back as an id, a name, a size and a `webViewLink`. Optional target folder and name override. It always creates a new file; it never overwrites or updates an existing one.
  - `list_filters` / `create_filter` / `delete_filter` — the account's mail rules.
  - `get_vacation` / `set_vacation` — the out-of-office responder.
- **Two new OAuth scopes, and every account must re-consent to use these six tools.** `drive.file` and `gmail.settings.basic` were added to the requested set. A token carries the permissions it was issued with, so **every alias authenticated before 2026-08-27 gets a 403 from the six new tools until it runs `npm run auth -- <alias>` again**. Each of those tools says exactly that in its own error message rather than reporting a generic authentication failure. Nothing else is affected: sending, reading, labels, Calendar and the Gmail signature all keep working on the existing grants.
- **`drive.file`, not full Drive write.** It is the narrow scope: it reaches only the files this server itself creates and can never touch anything else in the user's Drive. Reading the rest of Drive still goes through `search_drive_files` / `read_drive_file` under `drive.readonly`.
- **`upload_drive_file` refuses before it uploads.** A relative path, a path that does not exist, anything that is not a regular file, and anything over 100MB are all rejected without a network call. The body is streamed rather than buffered, and the stream is created inside the retried call so a retried attempt re-reads the file instead of sending nothing.
- **`create_filter` cannot create a forwarding filter.** Gmail filters can forward matching mail to another address; a tool able to create one could quietly route a mailbox off-site, and forwarding needs a separately verified address anyway. Existing forwarding filters are still reported by `list_filters` — the read side tells the truth about what is configured. A filter with no criteria (it would match everything) or with no label action (it would do nothing) is refused, as no-op label calls already are elsewhere.
- **`set_vacation` merges rather than replaces.** Gmail's `updateVacation` overwrites the whole settings object, so turning the responder off would have erased the message the user wrote, and changing the subject would have blanked the body. Current settings are fetched and the supplied fields merged over them — the same fetch-and-preserve rule the label tools follow. Enabling with no reply text anywhere, an unparseable date, or an inverted window are all refused.
- **Enabling the vacation responder is flagged as the outward act it is.** While it is on, the account replies automatically to anyone who writes in, with no further call to this server. The tool description says so, the switch is logged before it happens (flags only — never the auto-reply text), and the result carries a notice stating exactly what is now on.

### Changed
- **The Gmail signature lookup is now a properly scoped call.** `users.settings.sendAs.list` was verified working under the Gmail scopes alone, which is why the signature feature shipped without a re-consent. `gmail.settings.basic` is now requested, so once an alias re-consents the lookup stops leaning on observed behaviour. The call, its arguments and its graceful degradation are all unchanged — an account that has not re-consented sends exactly as it did before, and a failed signature lookup still costs a signature and never a send.

## [1.5.0] — 2026-08-27

### Added
- **Mail-arrival watching (2 tools)**, bringing the roster to 44:
  - `get_history_baseline` — the mailbox's current change cursor (`historyId`), plus the address and totals. One cheap call.
  - `get_mail_changes` — everything that arrived, was deleted or was relabelled since a cursor you supply, with the arrivals carrying From/Subject/Date. Optional filters by change kind and label; `include_summaries: false` turns the whole thing into one API call.
  - There is **no server-side state**: the caller keeps the cursor between polls, so any number of sessions, agents or scheduled jobs can watch the same mailbox without interfering.
  - **An expired cursor is reported as a resync, not as an error.** Gmail keeps roughly a week of history and answers 404 beyond it; the message says to fetch a fresh baseline and treat the gap as a full resync rather than as "no new mail".
  - **The cursor is not advanced while pages remain.** Gmail's response carries the mailbox's *current* cursor, not the end of the page, so storing it mid-pagination would skip everything unread. `complete` is false until the last page, and the note says to keep the old cursor until then.
  - Arrivals are fetched up to 100 per call; beyond that they come back as ids and labels with a note saying so, rather than as a silent fan-out of hundreds of round trips.
- **Inline images: `inline_images` on `send_email`, `draft_email`, `reply_email`, `draft_reply` and `update_draft`.** Absolute paths to images that live *in* the body instead of hanging off it. The message becomes `multipart/related` (nested inside `multipart/mixed` when there are attachments too), exactly as Gmail builds it.
  - The reference is the file's own name — `/home/me/logo.png` is `cid:logo.png` — so a composing model can write `<img src="cid:logo.png">` without a round trip. Two files that would answer to the same reference are refused rather than one silently shadowing the other.
  - Inline images count against the same 25MB budget as attachments, and `plain_text_only` refuses them for the same reason it refuses attachments.

### Fixed
- **Embedded images were invisible on the read side.** Attachment listing required a filename, and a pasted or `cid:`-referenced image usually has none — so `read_email` and `get_thread` reported no attachments while the body plainly referenced pictures, and `get_attachment` could not fetch one. Any downloadable part identifying itself as a file *or* an embedded image (filename, or Content-ID) is now listed, marked with `inline` and `contentId`. A large text body part that Gmail offloads is not affected: it has no Content-ID, so it stays the body.
- **`forward_email` keeps embedded images embedded.** Now that they are listed, they are re-attached as inline parts carrying their original Content-ID, which is what the forwarded HTML still references — instead of becoming a broken image plus a stray file.

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
- **The reflow pass welded typed sign-offs onto the sentence above them.** A four-line block ("…yesterday afternoon." / "Steve Angelo" / "Appraisal Host" / "555-1234") went out as one run-on line, because each seam was judged against the accumulated line rather than the paragraph. Reflow now classifies a whole paragraph: it collapses only when every line but the last is full-width and no line break looks authored, and otherwise ships the paragraph exactly as written. Composer wrapping at ~70 columns is still fully undone.

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
