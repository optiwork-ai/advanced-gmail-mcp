# Gmail MCP Server

![Advanced Gmail MCP](social-preview.png)

A Gmail [MCP server](https://modelcontextprotocol.io) for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) that provides full email management across multiple Gmail accounts.

## Features

- **35 tools** spanning Gmail (read, compose, draft management, modify, attachments, label management) plus read-only Google Chat, Drive, and Docs — see the [Tools](#tools) table
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
   - For the read-only Chat/Drive/Docs tools, also enable the **Google Chat API**, **Google Drive API**, and **Google Docs API**
4. Configure the **OAuth consent screen**:
   - APIs & Services → OAuth consent screen
   - User type: External (or Internal if using Google Workspace)
   - Add your email address(es) as test users
   - Add scopes: `gmail.readonly`, `gmail.modify`, `gmail.send`, `gmail.compose`
   - For read-only Chat/Drive/Docs, also add: `chat.spaces.readonly`, `chat.messages.readonly`, `drive.readonly`, `documents.readonly`, then re-run the auth flow for each alias (`npm run auth -- <alias>`) so the new scopes are granted
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
    { "email": "you@company.com", "alias": "work" }
  ],
  "default": "personal"
}
```

You can add as many accounts as you want. Each needs a unique `alias`.

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
| `list_emails` | List inbox or label emails |
| `search_emails` | Search with Gmail query syntax |
| `read_email` | Read full email by ID |
| `get_thread` | Get full thread with all messages |
| `get_labels` | List all labels |
| `get_attachment` | Fetch an attachment's bytes (base64) by attachmentId |
| `send_email` | Send a new email |
| `draft_email` | Create a draft |
| `reply_email` | Reply with proper threading |
| `draft_reply` | Draft a reply (review in Gmail before sending) |
| `send_draft` | Send an existing draft by ID |
| `list_drafts` | List drafts with id + headers |
| `read_draft` | Read a draft's full content by ID |
| `forward_email` | Forward an email to new recipients (text/HTML body, no attachments) |
| `archive_email` | Archive (remove INBOX label) |
| `label_email` | Add/remove labels |
| `trash_email` | Move to trash |
| `batch_modify` | Batch archive/trash/label |
| `unsubscribe_email` | Process `List-Unsubscribe` header (one-click HTTPS or mailto) |
| `mark_read` | Remove UNREAD label from a message |
| `mark_unread` | Add UNREAD label to a message |
| `star_email` | Add STARRED label |
| `unstar_email` | Remove STARRED label |
| `mark_important` | Add IMPORTANT label |
| `mark_not_important` | Remove IMPORTANT label |
| `create_label` | Create a new label (optionally colored) |
| `update_label` | Rename or recolor a label |
| `delete_label` | Delete a label (removes it from every message) |

### Read-only Chat / Drive / Docs

These tools are **strictly read-only** — nothing is sent, posted, created, updated, or deleted. They require the extra scopes above; re-run the auth flow per alias after adding them.

| Tool | Description |
|------|-------------|
| `list_chat_spaces` | List the Chat spaces/DMs the account belongs to |
| `list_chat_messages` | List messages in a Chat space (requires a space name/id) |
| `get_chat_message` | Read a single Chat message by resource name |
| `list_chat_members` | List the members of a Chat space |
| `search_drive_files` | Search Drive files with Drive `q` query syntax |
| `read_drive_file` | Read a Drive file's metadata + text (Docs/Sheets/Slides exported to text; binary types return metadata only; ~1MB cap) |
| `get_google_doc` | Read a Google Doc as title + flattened plain text |

All tools accept an optional `account` parameter (alias or email). Defaults to the account set in `accounts.json`.

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
