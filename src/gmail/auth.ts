import { google, type Auth } from 'googleapis';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { URL } from 'url';
import {
  type AccountConfig,
  getAccounts,
  getCredentialsPath,
  getTokenPath,
  resolveAccount,
} from '../config.js';
import type { StoredToken } from './types.js';

/**
 * Scopes: Gmail (read, modify, send, compose) + Calendar (events, free/busy,
 * calendarlist.readonly) for the demo-booking flow in appraisalhost-website,
 * plus read-only Chat / Drive / Docs (added 2026-07-11) for the
 * advanced-gmail-mcp read tools.
 *
 * calendarlist.readonly is required by the CRM's
 * `google_calendar._calendars_for_freebusy()` enumeration, which calls
 * `calendarList.list()` to discover every visible calendar (primary +
 * shared) before issuing a single `freeBusy.query` across them. Without
 * it, calendarList.list 403s with "Insufficient Permission" even when
 * calendar.events + calendar.freebusy are granted.
 *
 * Chat/Drive/Docs read scopes (chat.spaces.readonly, chat.messages.readonly,
 * drive.readonly, documents) back the Chat/Drive/Docs MCP tools.
 *
 * Chat POSTING (chat.messages.create, added 2026-08-28) ends the read-only
 * Chat posture, by the owner's ruling of that day. It backs one tool,
 * `post_chat_message`, and it is a WRITE scope in the plainest sense: a call
 * under it puts a message in front of everyone in the space, attributed to the
 * account. It does NOT include reading — `chat.messages.create` grants posting
 * only — so the two read-only Chat scopes stay exactly where they were.
 *
 * Two WRITE scopes were added 2026-08-27 for the Phase 2 tools:
 *   - drive.file — deliberately the narrow one. It grants access ONLY to files
 *     this app itself creates, never to the rest of the user's Drive; the broad
 *     read of Drive still comes from drive.readonly. It backs `upload_drive_file`.
 *   - gmail.settings.basic — backs the mail-rule and vacation-responder tools
 *     (`list_filters` / `create_filter` / `delete_filter`, `get_vacation` /
 *     `set_vacation`) and properly scopes the `users.settings.sendAs` signature
 *     lookup that composition already performs.
 *
 * Adding scopes is additive at the constant level — existing tokens keep
 * working with their current grants until each alias is RE-CONSENTED with
 * `npm run auth {alias}`. A token issued before a scope was added will NOT
 * carry that scope, so the Chat/Drive/Docs tools, and now the Drive-upload and
 * Gmail-settings tools, 403 until every alias that needs them is re-run
 * through the auth flow.
 */
export const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.freebusy',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  // Read-only Chat / Drive / Docs (added 2026-07-11)
  'https://www.googleapis.com/auth/chat.spaces.readonly',
  'https://www.googleapis.com/auth/chat.messages.readonly',
  // Chat POSTING (2026-08-28, owner ruling): posting only, no read. Every
  // alias must re-consent before post_chat_message will work.
  'https://www.googleapis.com/auth/chat.messages.create',
  'https://www.googleapis.com/auth/drive.readonly',
  // Write scopes (added 2026-08-27) — see the note above.
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/gmail.settings.basic',
  // Docs read AND write (2026-08-28). This REPLACED `documents.readonly`:
  // `documents` includes reading, so both Docs tools now travel on one grant,
  // and every alias must re-consent before update_google_doc will work.
  'https://www.googleapis.com/auth/documents',
];

const REDIRECT_URI = 'http://localhost:3000/oauth2callback';

/**
 * Load GCP OAuth credentials from credentials.json at project root.
 */
export function loadCredentials() {
  const credPath = getCredentialsPath();

  if (!fs.existsSync(credPath)) {
    throw new Error(
      `credentials.json not found at ${credPath}. Download it from Google Cloud Console.`
    );
  }

  const content = fs.readFileSync(credPath, 'utf-8');
  const credentials = JSON.parse(content);
  return credentials.installed || credentials.web;
}

/**
 * Get an authenticated OAuth2Client for an account.
 */
export async function getAuthClient(account: AccountConfig): Promise<Auth.OAuth2Client> {
  const credentials = loadCredentials();

  const oauth2Client = new google.auth.OAuth2(
    credentials.client_id,
    credentials.client_secret,
    REDIRECT_URI,
  );

  const tokenPath = getTokenPath(account);

  if (!fs.existsSync(tokenPath)) {
    throw new Error(
      `No token for ${account.email}. Run: npx tsx src/auth.ts ${account.alias}`
    );
  }

  const token: StoredToken = JSON.parse(fs.readFileSync(tokenPath, 'utf-8'));
  oauth2Client.setCredentials(token);

  // Refresh if expired (with 60s buffer)
  if (token.expiry_date && token.expiry_date < Date.now() + 60_000) {
    try {
      const { credentials: refreshed } = await oauth2Client.refreshAccessToken();
      oauth2Client.setCredentials(refreshed);

      const tokenDir = path.dirname(tokenPath);
      if (!fs.existsSync(tokenDir)) {
        fs.mkdirSync(tokenDir, { recursive: true });
      }
      fs.writeFileSync(tokenPath, JSON.stringify(refreshed, null, 2));
    } catch (err) {
      throw new Error(
        `Token refresh failed for ${account.email}. Re-authenticate: npx tsx src/auth.ts ${account.alias}\n` +
        `Error: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  return oauth2Client;
}

/**
 * Interactive OAuth flow: opens URL, starts local callback server, saves token.
 */
export async function authenticateAccount(account: AccountConfig): Promise<void> {
  const credentials = loadCredentials();

  const oauth2Client = new google.auth.OAuth2(
    credentials.client_id,
    credentials.client_secret,
    REDIRECT_URI,
  );

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    login_hint: account.email,
    prompt: 'consent',
  });

  console.log(`\nAuthenticating: ${account.email} (${account.alias})`);
  console.log(`\nOpen this URL in your browser:\n${authUrl}\n`);

  return new Promise((resolve, reject) => {
    let timeoutHandle: NodeJS.Timeout | undefined;

    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url || '', 'http://localhost:3000');
        const code = url.searchParams.get('code');

        if (code) {
          const { tokens } = await oauth2Client.getToken(code);

          const tokenPath = getTokenPath(account);
          const tokenDir = path.dirname(tokenPath);
          if (!fs.existsSync(tokenDir)) {
            fs.mkdirSync(tokenDir, { recursive: true });
          }

          fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 2));

          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(
            `<h1>Success!</h1><p>Authenticated ${account.email} (${account.alias})</p><p>You can close this window.</p>`
          );

          if (timeoutHandle) clearTimeout(timeoutHandle);
          server.close();
          console.log(`Token saved for ${account.email}`);
          resolve();
        }
      } catch (err) {
        res.writeHead(500);
        res.end('Authentication failed');
        if (timeoutHandle) clearTimeout(timeoutHandle);
        server.close();
        reject(err);
      }
    });

    server.listen(3000, () => {
      console.log('Waiting for OAuth callback on http://localhost:3000...');
    });

    // 5-minute timeout — abort if user never completes consent. Handle is
    // cleared on success/error above so the script exits promptly instead of
    // hanging for the full 5 minutes.
    timeoutHandle = setTimeout(() => {
      server.close();
      reject(new Error('Authentication timed out after 5 minutes'));
    }, 5 * 60 * 1000);
  });
}

/**
 * Check authentication status of all accounts.
 */
export function checkAuthStatus(): void {
  const accounts = getAccounts();

  console.log('\nAccount Status:');
  console.log('─'.repeat(60));

  for (const account of accounts) {
    const tokenPath = getTokenPath(account);
    const exists = fs.existsSync(tokenPath);

    let status = 'NOT AUTHENTICATED';
    let scopeInfo = '';

    if (exists) {
      try {
        const token: StoredToken = JSON.parse(fs.readFileSync(tokenPath, 'utf-8'));
        const expired = token.expiry_date && token.expiry_date < Date.now();
        const hasSendScope = token.scope?.includes('gmail.send');
        const hasComposeScope = token.scope?.includes('gmail.compose');

        status = expired ? 'EXPIRED (will auto-refresh)' : 'OK';
        scopeInfo = hasSendScope && hasComposeScope
          ? ' [send+compose]'
          : hasSendScope
            ? ' [send only]'
            : ' [read/modify only]';
      } catch {
        status = 'TOKEN CORRUPT';
      }
    }

    const icon = exists && status !== 'TOKEN CORRUPT' ? '+' : '-';
    console.log(
      `  ${icon} ${account.alias.padEnd(10)} ${account.email.padEnd(30)} ${status}${scopeInfo}`
    );
  }

  console.log('');
}
