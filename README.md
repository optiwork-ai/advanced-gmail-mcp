# Gmail MCP Server

![Advanced Gmail MCP](social-preview.png)

A Gmail [MCP server](https://modelcontextprotocol.io) for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) that provides full email management across multiple Gmail accounts.

## Features

- **69 tools** spanning Gmail (read, compose, draft management, modify, attachments, mailbox-change watching, thread and label management, mail rules and the vacation responder), Google Calendar, Google Drive (read plus upload, which can convert as it uploads), Google Docs (read, create, and append/find-replace), Google Sheets (write a range, append rows), Google Chat (read plus posting) and **Google Workspace administration** (domains, users, groups and group settings — see [Google Workspace admin](#google-workspace-admin)) — see the [Tools](#tools) table
- **Gmail-native outbound mail** — everything you send goes out as `multipart/alternative` (HTML plus a plain-text alternative), with your account's Gmail signature, quoted history on replies, and a proper `Name <address>` sender. Attachments supported on send, draft and reply; images can be embedded in the body with `inline_images` and referenced as `cid:filename`; forwards re-attach the original's files and keep its embedded images embedded
- **Watch for new mail without polling the whole inbox** — `get_history_baseline` hands you a cursor, `get_mail_changes` tells you what arrived, was deleted or was relabelled since it. Call it with no cursor for since-last-time: the server remembers the last complete position per account and per filter (in gitignored `cursors/`, beside `tokens/`), so an INBOX-only watcher and an unfiltered one do not consume each other's window. Passing your own cursor still works, and always wins
- **Multi-account** support with simple aliases
- **OAuth2** authentication with interactive CLI flow
- **Token auto-refresh** — re-authenticates transparently
- **Rate limit retry** with exponential backoff
- **Claude Code commands** included (`/email` and `/checkemail`) for structured inbox triage

## Quick Start

### 1. Clone & Install

```bash
git clone https://github.com/optiwork-ai/advanced-gmail-mcp.git
cd advanced-gmail-mcp
npm install
```

### 2. Google Cloud Setup

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or select an existing one)
3. Enable the APIs:
   - APIs & Services → Enable APIs → search "Gmail API" → Enable
   - For the Chat/Drive/Docs tools, also enable the **Google Chat API**, **Google Drive API**, and **Google Docs API**
   - For the Calendar tools, also enable the **Google Calendar API**
4. Configure the **OAuth consent screen**:
   - APIs & Services → OAuth consent screen
   - User type: External (or Internal if using Google Workspace)
   - Add your email address(es) as test users
   - Add scopes: `gmail.readonly`, `gmail.modify`, `gmail.send`, `gmail.compose`
   - For Chat/Drive/Docs, also add: `chat.spaces.readonly`, `chat.messages.readonly`, `drive.readonly`, `documents`, then re-run the auth flow for each alias (`npm run auth -- <alias>`) so the new scopes are granted
   - For `post_chat_message`, also add: **`chat.messages.create`** — NEW on 2026-08-28, so **every alias needs a fresh `npm run auth -- <alias>` before it can post**. It grants posting only and does not include reading, which is why the two read-only Chat scopes stay alongside it. Until an alias re-consents, `post_chat_message` returns an error naming this exact scope and that exact command
   - **`documents` replaced `documents.readonly` on 2026-08-28** so that `update_google_doc` can write. It covers reading too, so both Docs tools travel on the one grant from now on. The swap is **read-compatible**: an account authenticated before then keeps the grants it was issued, so `get_google_doc` goes on working — only `update_google_doc` needs the re-consent
   - For Calendar, also add: `calendar.events`, `calendar.freebusy`, `calendar.calendarlist.readonly`
   - For `upload_drive_file` and `create_google_doc`, also add: `drive.file` — the narrow Drive scope, which reaches only the files this server itself creates. `create_google_doc` makes its document through Drive, so it needs **no** Docs scope and no extra consent beyond this one
   - **The two Sheets write tools need no scope of their own.** `update_sheet_values` and `append_sheet_rows` ride that same `drive.file` grant, so no alias re-consents for them. The trade is deliberate and it is a real boundary: they can write ONLY to spreadsheets this server created — which is what `upload_drive_file` with `convert: true` produces. A spreadsheet made in Google Sheets by hand is invisible to them, and the tools say so in plain words when you try. Widening to the full `spreadsheets` scope was deferred until something actually needs it, because it would put every account through consent again
   - **Enable the Google Sheets API** on the Cloud project (APIs & Services → Library → Google Sheets API). This is a project switch, not a permission: it costs nobody a sign-in, and until it is on, the first Sheets write returns an error that names the console page to open
   - For the mail-rule and vacation-responder tools, also add: `gmail.settings.basic`
   - **For the Google Workspace admin tools (NEW on 2026-09-02), add the eleven admin scopes** — `admin.directory.user`, `admin.directory.user.security`, `admin.directory.group`, `admin.directory.group.member`, `admin.directory.orgunit`, `admin.directory.domain`, `admin.directory.customer`, `admin.directory.rolemanagement`, `admin.directory.resource.calendar`, `admin.directory.userschema` and `apps.groups.settings`. These are requested **only by the accounts you flag `"workspace_admin": true`** in `accounts.json`, so an ordinary mailbox is never shown a consent screen asking to hand over a company directory. Each flagged alias then needs `npm run auth -- <alias>` before any admin tool works. There is no separate alias scope to add: Google folds user aliases into `admin.directory.user` and group aliases into `admin.directory.group`. Device-management scopes are deliberately **not** requested
   - **Enable the Admin SDK API and the Groups Settings API** on the Cloud project (APIs & Services → Library). Both are project switches, not permissions: they cost nobody a sign-in, and until each is on, the first call that needs it returns an error naming the console page to open
5. Create **OAuth credentials**:
   - APIs & Services → Credentials → Create Credentials → OAuth client ID
   - Application type: **Desktop app**
   - Download the JSON file
6. Save the downloaded file as `credentials.json` in the project root

### 3. Configure Accounts

```bash
cp accounts.example.json accounts.json
```

Edit `accounts.json` with your Gmail accounts:

```json
{
  "accounts": [
    { "email": "you@gmail.com", "alias": "personal" },
    { "email": "you@company.com", "alias": "work" },
    { "email": "admin@company.com", "alias": "work-admin", "workspace_admin": true }
  ],
  "default": "personal"
}
```

You can add as many accounts as you want. Each needs a unique `alias`.

**`workspace_admin`** (optional, default false) marks an account as an administrator of a
Google Workspace. It does two things, and both of them are restrictions rather than powers:

1. **only** a flagged account is asked for the Google Admin SDK permissions when it signs in,
   so a consumer mailbox or a shared inbox never sees that consent screen; and
2. **only** a flagged account may make an administrative call — the tools in
   [Google Workspace admin](#google-workspace-admin) refuse anything else before they send
   anything, naming the account you gave, this field, and which accounts are flagged today.

Setting it grants nothing by itself. The account must then be re-run through
`npm run auth -- <alias>`, because a token carries the permissions it was issued with and no
others. Flag it only on accounts that really do administer a Workspace.

### 4. Authenticate

```bash
# Authenticate all accounts (opens browser for each)
npm run auth

# Or authenticate a single account
npm run auth -- work

# Check auth status
npm run auth:check
```

The auth flow opens a browser window for each account. Tokens are saved to `./tokens/`.

> **Adding a scope means re-consenting.** A token carries exactly the permissions that were granted when it was issued — editing the scope list does nothing to a token already on disk. That cuts both ways, and it is why **`documents` replacing `documents.readonly` on 2026-08-28 does NOT break reading**: an older token still carries `documents.readonly` (and `drive.readonly`), either of which Google accepts for `documents.get`, so `get_google_doc` keeps working untouched. Only `update_google_doc` — the write — answers 403 until that alias runs `npm run auth -- <alias>` again, and it says so in its own error message. **`drive.file` and `gmail.settings.basic` were added on 2026-08-27**, so on any account authenticated before then, `upload_drive_file`, `list_filters`, `create_filter`, `delete_filter`, `get_vacation` and `set_vacation` answer **403 until that alias runs `npm run auth -- <alias>` again**. Those tools say so in their own error messages. Everything else keeps working untouched in the meantime — nothing about sending, reading or the Gmail signature depends on the new grants.
>
> **The admin permissions added on 2026-09-02 are asked for PER ACCOUNT.** An account flagged `"workspace_admin": true` is sent through consent with the eleven Admin SDK scopes appended; an account without the flag is sent through with exactly the list it had before, unchanged. So re-run `npm run auth -- <alias>` for each flagged account and **for no others** — nothing about an unflagged account has changed, and re-consenting it would gain nothing. `npm run auth:check` reports the state per account: `[admin]` when the token really carries directory permissions, `[admin: NOT CONSENTED — run npm run auth -- <alias>]` when the account is flagged but its token predates them, and nothing at all when the account is not flagged.

### 5. Add to Claude Code

Add to your MCP config (project `.mcp.json` or `~/.claude.json`):

```json
{
  "mcpServers": {
    "gmail": {
      "type": "stdio",
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/gmail-mcp/src/server.ts"]
    }
  }
}
```

> **Important:** Use the absolute path to `src/server.ts`.

### 6. (Optional) Add Commands

Copy the included Claude Code commands for structured email workflows:

```bash
# From your project root (where .claude/ lives)
mkdir -p .claude/commands
cp /path/to/gmail-mcp/.claude/commands/email.md .claude/commands/
cp /path/to/gmail-mcp/.claude/commands/checkemail.md .claude/commands/
```

Then use `/email` or `/checkemail` in Claude Code.

## Tools

| Tool | Description |
|------|-------------|
| `list_emails` | List inbox or label emails (50 per page, `page_token` for more) |
| `search_emails` | Search with Gmail query syntax (50 per page, `page_token` for more) |
| `read_email` | Read full email by ID |
| `get_thread` | Get full thread with all messages, bodies and attachment metadata |
| `get_labels` | List all labels (`include_counts` for message counts) |
| `get_history_baseline` | Get the mailbox's current change cursor (`historyId`) — the starting point for watching for new mail |
| `get_mail_changes` | What arrived / was deleted / was relabelled since a cursor, plus the next cursor. Omit `history_id` to continue from where this account was last read to — remembered per account AND per filter (`label_id` + `history_types`), so poll with the same filter each time; a supplied cursor still wins |
| `get_attachment` | Fetch an attachment — including an image embedded in the body: writes it to `save_dir`, or returns it inline for files up to 1MB. PNG/JPEG/GIF/WebP come back as a **viewable image**, so Claude can read what is in the picture; everything else as base64 |
| `send_email` | Send a new email (Gmail-native HTML + text, signature, attachments, `inline_images` embedded via `cid:`) |
| `draft_email` | Create a draft (same composition as `send_email`) |
| `reply_email` | Reply with proper threading, `Reply-To` handling and quoted history |
| `draft_reply` | Draft a reply (review in Gmail before sending) |
| `send_draft` | Send an existing draft by ID |
| `list_drafts` | List drafts with id + headers (paginated) |
| `read_draft` | Read a draft's full content by ID |
| `update_draft` | Replace a draft's contents (same composition as `draft_email`) |
| `delete_draft` | Permanently delete a draft |
| `forward_email` | Forward an email to new recipients, re-attaching the original's attachments and keeping its embedded images embedded |
| `archive_email` | Archive (remove INBOX label) |
| `label_email` | Add/remove labels |
| `trash_email` | Move one message to trash |
| `modify_thread` | Add/remove labels on every message in a thread (archive = remove `INBOX`) |
| `trash_thread` | Move an entire thread to trash |
| `batch_modify` | Batch archive/trash/label, chunked, with per-failure reporting |
| `unsubscribe_email` | Process `List-Unsubscribe` header (one-click HTTPS, or a mailto send that needs `confirm: true`) |
| `mark_read` | Remove UNREAD label from a message |
| `mark_unread` | Add UNREAD label to a message |
| `star_email` | Add STARRED label |
| `unstar_email` | Remove STARRED label |
| `mark_important` | Add IMPORTANT label |
| `mark_not_important` | Remove IMPORTANT label |
| `create_label` | Create a new label (optionally colored) |
| `update_label` | Rename or recolor a label |
| `delete_label` | Delete a label (removes it from every message); requires `confirm: true` |

### Mailbox settings — mail rules and the vacation responder

These need `gmail.settings.basic` (added 2026-08-27), so they **403 on any alias that has not re-consented** — see the note in step 4.

| Tool | Description |
|------|-------------|
| `list_filters` | List the account's filters: what each matches and which labels it adds or removes. Read-only, and it reports an existing forwarding filter even though `create_filter` cannot make one |
| `create_filter` | Create a mail rule. Affects future mail only. At least one criterion and one label action required; adding `TRASH` is how a filter deletes and removing `INBOX` is how it archives. **Cannot create a forwarding filter** — deliberately |
| `delete_filter` | Delete a filter permanently (no undo; existing mail is unaffected) |
| `get_vacation` | Read the vacation-responder settings: on/off, subject, message, window, restrictions |
| `set_vacation` | **Turn the vacation responder on or off.** While it is on, Gmail auto-replies from this account without any further call. Turning it ON requires `confirm: true` and is refused if the saved window already ended; turning it OFF needs neither. Settings are merged, not replaced, so turning it off keeps the saved message |

**On `set_vacation`, two rules govern enabling.** `enable: true` is refused unless `confirm: true` is passed with it, and it is refused when the responder's saved window has already ended — an old responder is never silently brought back to life, so pass a new `start_time` and `end_time` for the absence you actually mean. `enable: false` needs neither: the safe direction is never harder than the dangerous one. Enabling the responder is the one setting in this server that makes the account send mail on its own — anyone who writes in gets an automatic reply until it is switched off or its `end_time` passes. Prefer setting `end_time`. Omitted fields keep their saved values, so `enable: false` never erases the message and changing the subject never blanks the body. The result carries a `notice` stating exactly what is now switched on. Gmail stores the reply in two forms, plain text and HTML, and sends the HTML one when both exist — so passing `body` rewrites **both**, and what you passed is what goes out whichever form Gmail picks.

### Chat / Drive / Docs / Sheets

**Chat can now post.** The read-only Chat posture ended on 2026-08-28 by the owner's ruling; `post_chat_message` puts a real message in a space, attributed to the account that sent it, and it does so without a confirmation step — the same posture `send_email` has, because the use case is automated alerting from scheduled sessions and a post can be deleted in Chat by its author afterwards. Treat it accordingly. Two things about the message body are worth knowing, because neither is obvious: the first link in it becomes a preview chip, and Chat mention markup (`<users/all>`) notifies everyone in the space — so mention markup is made inert before posting unless `allow_mentions: true` is passed, which stops text quoted out of an email or a log file from paging a room. Nothing here edits or deletes an existing message, and no scope for either is requested. Drive is read-only except `upload_drive_file` and `create_google_doc`, both of which only ever CREATE, under the narrow `drive.file` scope (it reaches only files this server itself created, never the rest of your Drive). Docs is read plus two writes: `create_google_doc`, which makes a new document through Drive and therefore needs no Docs scope at all, and `update_google_doc`, whose surface is append-text and find-replace — there is no way to insert at a position, because a position is a number in a document the caller cannot see. Sheets is write-only here, and rides `drive.file` too — see the section below. These tools require the extra scopes above; re-run the auth flow per alias after adding them.

| Tool | Description |
|------|-------------|
| `list_chat_spaces` | List the Chat spaces/DMs the account belongs to (name, displayName, spaceType, spaceDetails) |
| `list_chat_messages` | List messages in a Chat space (requires a space name/id; newest first). Returns name, sender, createTime, text, thread, plus attachments when a file was shared |
| `get_chat_message` | Read a single Chat message by resource name |
| `post_chat_message` | **Posts a real message people in the space will see**, as the account you name — no draft, no preview, no confirmation step. Plain text, 4096-character limit (a longer message is refused before anything is posted). `thread` replies inside an existing conversation (a thread name, or a message name whose thread is used) and the answer says whether it landed there or Chat started a new thread — to keep a run of alerts in one conversation, pass the thread name back from the first answer (`thread_key` is meant for that but is not confirmed to work for messages posted as a user, and fails silently). Chat mention markup (`<users/all>`) is made inert unless `allow_mentions` is set, so text quoted from an email or a log cannot page a room. A failed post says whether the message may have landed anyway, and names the `request_id` to retry under. Needs `chat.messages.create` |
| `search_drive_files` | Search Drive files with Drive `q` query syntax — My Drive **and** shared (team) drives by default (`include_shared_drives: false` to narrow) |
| `read_drive_file` | Read a Drive file's metadata + text, from My Drive **or** a shared (team) drive (Docs/Sheets/Slides exported to text; binary types return metadata only; ~1MB cap; read `contentNote` — a Sheets export is first-sheet-only) |
| `upload_drive_file` | **Uploads a local file to Drive** (absolute path, optional `folder_id` and `name`; 100MB ceiling) and returns its id, name, size and `webViewLink`. Always creates a new file — it never overwrites one. **`convert: true`** lands it as a *real* Google Sheet, Doc or Slides deck instead of a stored `.xlsx`/`.csv`/`.docx`, so it opens and edits like one — and so the Sheets write tools can reach it. Convertible: `xlsx, xls, ods, csv, tsv` → Sheets; `docx, doc, odt, rtf, txt` → Docs; `pptx, ppt, odp` → Slides. Any other type is refused before the upload starts rather than stored unconverted. A converted file has no byte size of its own, so `driveSize` is simply absent. Needs `drive.file` |
| `get_google_doc` | Read a Google Doc as title + flattened plain text |
| `create_google_doc` | **Creates a real Google Doc** (title required, optional plain-text `initial_text` and `folder_id`) and returns its `documentId`, title and `webViewLink`. Made through Drive's `files.create`, so it needs `drive.file` — already granted since 2026-08-27 — and no Docs consent |
| `update_google_doc` | Edit a Google Doc: append text at the end and/or replace text you name. No index arithmetic — the result reports how many occurrences each replacement actually changed |

### Sheets

Two tools, both writes, and no scope of their own: they travel on the `drive.file` grant every alias already holds, so **nobody re-consents for these**. What that grant buys is bounded, and the boundary is the thing to understand before using them — `drive.file` reaches only files this server itself created. A spreadsheet made in Google Sheets by hand, or uploaded by another tool, is not merely forbidden to them; it is *invisible*, and Google answers with the same "not found" it uses for an id that never existed. Both tools recognise that case and explain it rather than passing Google's answer along.

The way to bring data into reach is `upload_drive_file` with `convert: true`: the workbook lands as a real Google Sheet that this server owns, and both tools can then write to it. That is the whole loop — upload converted, write the revision back, no re-upload.

Reading a spreadsheet is not here because it already exists: `read_drive_file` exports one as CSV.

One project-level switch is needed once, and it is not a permission: the **Google Sheets API** has to be enabled on the Cloud project. If it is not, the first write returns an error naming the console page to open, and says plainly that re-authenticating will not help.

| Tool | Description |
|------|-------------|
| `update_sheet_values` | **Overwrites a range** of a spreadsheet this server created. `range` is A1 notation (`Sheet1!A1:C10`); `values` is rows of strings, numbers, booleans or `null`. Every cell the range covers is replaced — the only way back is the spreadsheet's version history. `value_input_option` defaults to `user_entered`, so `=SUM(A1:A2)` becomes a formula and `5%` a percentage; `raw` stores everything literally. Retried on a server error, because writing the same range twice writes it once. Returns the range, rows and cells Google says it actually changed |
| `append_sheet_rows` | **Adds rows to the end of a table**, overwriting nothing: the rows are INSERTED, so anything sitting below the table is pushed down rather than replaced (Google's default would overwrite it). `range` is an *anchor* — `Sheet1`, or `Sheet1!A1` to name the table starting there — and Google finds the end of it. **Not retried:** `values.append` is not idempotent, and a retry after a write that quietly landed would add every row twice, so a server error is reported instead of guessed at |

Both refuse more than **1,000 rows or 10,000 cells** in one call, before anything is sent — the caller can batch — and both log the spreadsheet, range and size of a write, never a cell's contents.

### Google Workspace admin

Fourteen tools that act on a company's **directory** rather than on a mailbox: the domains a
Workspace owns, the people in it, the Google Groups that most of its addresses actually are,
and the settings that decide whether an address accepts mail from outside the company.

They exist for a concrete job. A persona address — `sophie@appraisalhost.com`, say — is a
Google Group at the business domain, set to accept mail from anyone and to forward it to an
address outside the Workspace. "Accepts outside mail" is a Groups Settings property, and no
mailbox setting anywhere can express it, which is why these tools are here.

**These tools have no default account.** Every other tool in this server falls back to the
account named in `accounts.json` when you do not say which one to use. These refuse: `account`
is required, and it must be an account flagged `"workspace_admin": true`. The default account
is an ordinary mailbox, and an administrative call landing on the wrong company is not a
mistake worth risking for convenience. The refusal happens before anything is sent, and it
names the account you gave, the field to add, and which accounts are flagged today.

**Two confirmations are enforced, not advisory.** `delete_group` and `create_workspace_user`
are refused unless `confirm: true` is passed — the first because mail to a deleted address
bounces from then on with no undo, the second because a user is a **paid monthly seat**.
`update_workspace_user` needs one too, but only for suspending someone; unsuspending does not.

**Creating a group is free. Creating a user is not.** A shared address, a persona address, a
distribution list and a second address for someone are all free — a group or an alias. Only a
person costs a licence. The tool descriptions say so, in those words.

| Tool | Description |
|------|-------------|
| `list_workspace_domains` | Every domain in the Workspace, with `isPrimary`, `verified` and its domain aliases. **Run this first on any admin account:** it answers whether a second domain is a Workspace of its own or a secondary domain of this one, which decides which account does the work for it |
| `list_workspace_users` | The people in the Workspace — address, full name, suspended, admin, org unit, aliases, last sign-in. Optional `domain`, Google `query` syntax (`email:emma*`, `isAdmin=true`), `max_results` (default 100, capped at 500) and `page_token`. Passwords are never returned |
| `get_workspace_user` | One person, with the details a listing leaves out: recovery address, creation time, terms accepted, two-step verification, and whether they must change their password at next sign-in |
| `list_groups` | The Google Groups in the Workspace — address, name, description, direct member count, aliases, `adminCreated`. Optional `domain`, group `query` syntax, or `user_key` to list the groups one person belongs to. `max_results` default 100, capped at Google's own 200 |
| `get_group` | **One group in full: the group, its SETTINGS and its members.** The call that shows an address's whole posture — who may post to it, whether mail from outside the company is accepted or refused, whether messages are held for moderation, and who receives what is sent there. Up to 200 members, and it says `members_truncated` when there are more. If the settings cannot be read it says so out loud rather than returning a group with a silently missing settings block, because "no settings" reads as "no restrictions" |
| `create_group` | **WRITE.** Creates the address, then applies `settings`, then adds `members` — in that order, because an address outside the Workspace cannot be added until `allow_external_members` is true. FREE: no licence, no monthly fee. Nothing is rolled back if a later step fails; the answer carries `settings_applied`, `members_added` and `members_failed` so it says exactly what landed. A fresh group is invisible to the settings API for a few seconds, so the settings step is retried for about fifteen. Never retried on a server error — a retry would make a second group |
| `update_group_settings` | **WRITE.** Changes how an address behaves for everyone who mails it. Only the settings you pass are changed. The answer is a fresh **read** afterwards rather than an echo of the request, so it reports what Google actually holds |
| `delete_group` | **WRITE, destructive.** Mail sent to the address BOUNCES from then on, including from customers. Archived conversations and membership go with it and there is **no undo**. Refused unless `confirm: true` |
| `add_group_member` | **WRITE.** The address starts receiving the group's mail. Can be a person, another group, or an address outside the Workspace — which is how a persona address forwards into a CRM — but Google refuses an outside address unless `allow_external_members` is true, and this tool restates that refusal with the cure rather than passing on "Invalid Input" |
| `remove_group_member` | **WRITE.** Ends a membership. The address itself is untouched |
| `add_group_alias` | **WRITE.** Another address that reaches the same group. Free |
| `create_workspace_user` | **WRITE, and it costs money.** A new person is a PAID Workspace seat, billed monthly for as long as the account exists; deleting it later refunds nothing. Refused unless `confirm: true`. If no `password` is given, a strong one is generated, returned **once** in the answer, and never written to the log; the person must change it at first sign-in unless you say otherwise. Never retried — a retry would create a second person on a second seat |
| `update_workspace_user` | **WRITE.** Change name, org unit, recovery address, or suspension. Only the fields you pass are changed (it uses `users.patch`, not `users.update`, which would blank everything you did not restate). `suspended: true` needs `confirm: true`; `suspended: false` does not |
| `add_user_alias` | **WRITE.** Another address that reaches the same person. Free — which is why a second address for someone should be an alias rather than a second user |

#### The settings, and the recipe for accepting outside mail

`create_group`, `update_group_settings` and `get_group` all share one allow-listed settings
shape. The Groups Settings API carries dozens of fields, most of them about the Google Groups
web forum rather than about mail, so these nineteen are the ones this server reads and writes:
`who_can_post_message`, `allow_external_members`, `who_can_view_group`,
`who_can_view_membership`, `who_can_join`, `who_can_discover_group`, `who_can_contact_owner`,
`message_moderation_level`, `spam_moderation_level`, `reply_to`, `custom_reply_to`,
`include_in_global_address_list`, `allow_web_posting`, `is_archived`,
`enable_collaborative_inbox`, `members_can_post_as_the_group`, `who_can_leave_group`, `name`
and `description`.

Booleans are real `true` and `false` here. Google carries them as the *strings* `"true"` and
`"false"`; the translation happens in one place so nobody calling these tools has to know.

**To make an address accept mail from outside the company you need four settings together,**
not one:

```json
{
  "who_can_post_message": "ANYONE_CAN_POST",
  "allow_external_members": true,
  "spam_moderation_level": "ALLOW",
  "message_moderation_level": "MODERATE_NONE"
}
```

The last two matter as much as the first two: without them, forwarded mail is accepted and
then held for a moderator nobody is watching, which looks exactly like mail that never
arrived. None of the four is applied unless you ask for it — the tools send what they are
given and nothing else.

#### On Workspace admin permission errors

A 403 here says what is actually wrong, and never sends you round a loop. A missing permission
names the scope and the exact `npm run auth -- <alias>`. An API that was never switched on
names the console page and says plainly that signing in again will not help. A refusal that is
really a missing **administrator role** says that — the sign-in is fine and the permission was
granted; what is missing is a role a Workspace super administrator grants in the Admin console.
A rate limit reports itself as a rate limit and is retried.

### Calendar

Three read-only tools plus one that writes. The Calendar scopes (`calendar.events`, `calendar.freebusy`, `calendar.calendarlist.readonly`) are already in the scope list; an alias whose token predates them must be re-authenticated before these work.

| Tool | Description |
|------|-------------|
| `list_calendars` | List the calendars the account can see (id, summary, timeZone, accessRole, primary) |
| `list_calendar_events` | List events on a calendar — recurring events expanded, start-time order, 50 per page (max 250), `page_token` for more |
| `get_freebusy` | Busy intervals across one or more calendars in a time window (no event titles) |
| `create_calendar_event` | **Creates an event.** `send_updates` defaults to `"none"` — nobody is emailed. Passing `"all"` makes Google email every attendee an invitation. `add_meet: true` also attaches a **Google Meet room** and returns its link |

**On Calendar permission errors:** a Calendar 403 says what is actually wrong. A missing calendar scope names that scope and the exact `npm run auth -- <alias>` command; a project with the Google Calendar API switched off says to enable it in the Cloud console and states plainly that re-authenticating will not help; a rate limit reports itself as a rate limit. None of them tell you to redo a login that is working.

**On `create_calendar_event` and invitation email:** adding attendees does not notify them. `send_updates` decides that, and its default is `"none"`, so the default path sends no mail at all. `"all"` is an outward-facing act — Google mails every attendee — and `"externalOnly"` mails only attendees outside your Workspace domain. The tool's result carries a `notice` stating which happened.

**On `create_calendar_event` and the Meet room:** `add_meet: true` asks Google to attach a Google Meet room to the event, and the result carries `meetLink` and `meetStatus`. It emails nobody on its own — `send_updates` still decides that, and still defaults to `"none"`.

The room is not always ready the instant the event is: Google can accept the request and finish building the room a moment later. So a room reported as still building is re-read from the event a few times over about fifteen seconds, and one of three things comes back. `"success"` means the link in `meetLink` is real and usable. `"pending"` means the room was requested and is still being made — there is **no** `meetLink` in that case, because a link that does not exist yet is never invented; read it a minute later with `list_calendar_events`, which returns the event's `hangoutLink`. `"failure"` means Google could not attach a room at all: the event still exists and is still returned, and a room can be added by hand from the event in Google Calendar. The `notice` says which of the three happened in plain words.

This works on a personal `@gmail.com` account as well, not only on Workspace ones: every account configured here, the consumer one included, was checked against Google on 2026-09-01 and each got a real room back. If Google ever does refuse a room on some account, it comes back as `"failure"` with the event intact, not as a broken call.

Every tool accepts an `account` parameter (alias or email). It is **optional everywhere except
the Google Workspace admin tools**, and defaults to the account set in `accounts.json`. Those
fourteen require it, and require the account to be flagged `"workspace_admin": true` — see
[Google Workspace admin](#google-workspace-admin) for why.

## Commands

### `/email [action] [account]`

Full email management command with actions:
- **triage** — Summarize inbox, batch archive/trash
- **cleanup** — 4-phase daily email workflow
- **search {query}** — Cross-account search
- **send / draft / reply** — Compose with confirmation

### `/checkemail [account]`

Quick 3-phase inbox sweep:
1. Fetch & classify all inbox emails (auto-archive junk)
2. Batch archive on approval
3. Walk through remaining emails one at a time — per-email actions include archive, reply, and unsubscribe (offered when a `List-Unsubscribe` header is present)

## Logging

The server writes one JSON line per event (retries, auth errors, startup) to a log file.

| Variable | Default | Effect |
|----------|---------|--------|
| `GMAIL_MCP_LOG_PATH` | `~/.cache/gmail-mcp/server.log` | Path for the JSON-lines log |
| `GMAIL_MCP_LOG_DISABLE` | unset | Set to `1` to disable logging entirely |

Tail it with `tail -f ~/.cache/gmail-mcp/server.log | jq` to watch live activity.

## Smoke testing

`scripts/smoke.ts` is a CLI harness that exercises individual client functions against real Gmail. Useful for verifying changes locally without going through an MCP host.

```bash
# Read-only — safe to run any time
tsx scripts/smoke.ts list personal 10
tsx scripts/smoke.ts search personal "category:promotions" 
tsx scripts/smoke.ts inspect personal <message-id>
tsx scripts/smoke.ts listDrafts personal

# Write operations — actually modify Gmail state
tsx scripts/smoke.ts markUnread personal <message-id>
tsx scripts/smoke.ts forward personal <message-id> you@example.com
tsx scripts/smoke.ts trash personal <message-id>
```

Run `tsx scripts/smoke.ts` with no args to see the full command list.

## Testing

```bash
npm run typecheck  # tsc --noEmit
npm test           # vitest unit tests
```

CI runs both on every push and PR ([.github/workflows/ci.yml](.github/workflows/ci.yml)).

**There is no build step, on purpose.** The server runs straight from `src/` via `tsx`, so
compiled output is never loaded — but a `dist/` sitting on disk looks like the thing that
runs, and a stale one (or one built from a different branch) is a trap for the next person
to read the repo. The `build` script has been removed and `tsconfig.json` sets
`"noEmit": true`, so a bare `tsc` checks types and writes nothing. If you have an old
`dist/` from before this change, delete it: `rm -rf dist`.

## Troubleshooting

| Error | Fix |
|-------|-----|
| `accounts.json not found` | Copy `accounts.example.json` to `accounts.json` |
| `credentials.json not found` | Download OAuth credentials from GCP Console |
| `No token for...` | Run `npm run auth -- <alias>` |
| `Token refresh failed` | Re-authenticate: `npm run auth -- <alias>` |
| `403 Forbidden` | Add your email as test user in GCP OAuth consent screen |
| `403 insufficient scopes` | Re-authenticate to get updated scopes |

## License

MIT
