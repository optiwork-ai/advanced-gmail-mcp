# Gmail MCP Server

![Advanced Gmail MCP](social-preview.png)

A Gmail [MCP server](https://modelcontextprotocol.io) for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) that provides full email management across multiple Gmail accounts.

## Features

- **12 tools**: list, search, read, thread, labels, send, draft, reply, archive, label, trash, batch modify
- **Multi-account** support with simple aliases
- **OAuth2** authentication with interactive CLI flow
- **Token auto-refresh** — re-authenticates transparently
- **Rate limit retry** with exponential backoff
- **Claude Code commands** included (`/email` and `/checkemail`) for structured inbox triage

## Quick Start

### 1. Clone & Install

```bash
git clone https://github.com/coreyepstein/advanced-gmail-mcp.git
cd advanced-gmail-mcp
npm install
```

### 2. Google Cloud Setup

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or select an existing one)
3. Enable the **Gmail API**:
   - APIs & Services → Enable APIs → search "Gmail API" → Enable
4. Configure the **OAuth consent screen**:
   - APIs & Services → OAuth consent screen
   - User type: External (or Internal if using Google Workspace)
   - Add your email address(es) as test users
   - Add scopes: `gmail.readonly`, `gmail.modify`, `gmail.send`, `gmail.compose`
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
| `send_email` | Send a new email |
| `draft_email` | Create a draft |
| `reply_email` | Reply with proper threading |
| `archive_email` | Archive (remove INBOX label) |
| `label_email` | Add/remove labels |
| `trash_email` | Move to trash |
| `batch_modify` | Batch archive/trash/label |

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
3. Walk through remaining emails one at a time

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
