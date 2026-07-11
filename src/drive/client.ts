import { google } from 'googleapis';
import type { drive_v3 } from 'googleapis';
import type { Auth } from 'googleapis';
import { type AccountConfig, resolveAccount } from '../config.js';
import { getAuthClient } from '../gmail/auth.js';

// ---------------------------------------------------------------------------
// Client cache: Google Drive API client per account with 50-min TTL.
// Mirrors the caching idiom in src/gmail/client.ts. READ-ONLY use only —
// callers must never invoke a mutating Drive method (create/update/delete).
// ---------------------------------------------------------------------------

interface CachedClient {
  client: Auth.OAuth2Client;
  drive: drive_v3.Drive;
  expiresAt: number;
}

const CLIENT_CACHE = new Map<string, CachedClient>();
const CLIENT_TTL_MS = 50 * 60 * 1000; // 50 minutes

/**
 * Get an authenticated Google Drive API client for an account.
 * Reuses the shared OAuth client + per-account token store via getAuthClient.
 * Caches the built client per account with a 50-min TTL.
 */
export async function getDriveClient(account?: string | AccountConfig): Promise<drive_v3.Drive> {
  const resolved = typeof account === 'string' || account === undefined
    ? resolveAccount(account)
    : account;

  const cacheKey = resolved.email;
  const cached = CLIENT_CACHE.get(cacheKey);

  if (cached && Date.now() < cached.expiresAt) {
    return cached.drive;
  }

  const authClient = await getAuthClient(resolved);
  const drive = google.drive({ version: 'v3', auth: authClient });

  CLIENT_CACHE.set(cacheKey, {
    client: authClient,
    drive,
    expiresAt: Date.now() + CLIENT_TTL_MS,
  });

  return drive;
}
