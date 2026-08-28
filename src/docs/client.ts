import { google } from 'googleapis';
import type { docs_v1 } from 'googleapis';
import type { Auth } from 'googleapis';
import { type AccountConfig, resolveAccount } from '../config.js';
import { getAuthClient } from '../gmail/auth.js';

// ---------------------------------------------------------------------------
// Client cache: Google Docs API client per account with 50-min TTL.
// Mirrors the caching idiom in src/gmail/client.ts. READ-ONLY use only —
// callers must never invoke a mutating Docs method (create/batchUpdate).
// ---------------------------------------------------------------------------

interface CachedClient {
  client: Auth.OAuth2Client;
  docs: docs_v1.Docs;
  expiresAt: number;
}

const CLIENT_CACHE = new Map<string, CachedClient>();
const CLIENT_TTL_MS = 50 * 60 * 1000; // 50 minutes

/**
 * The scope the Docs calls need, named here so a missing-scope error can quote
 * it back at the caller (see `src/google-api-error.ts`).
 *
 * This became `documents` (read AND write) on 2026-08-28, replacing
 * `documents.readonly`, when update_google_doc was added. It is ONE constant on
 * purpose: reading and writing now travel on the same grant, so an error that
 * quoted the old read-only scope would name a permission that re-consenting
 * will not produce.
 */
export const DOCS_SCOPE = 'https://www.googleapis.com/auth/documents';

/**
 * Get an authenticated Google Docs API client for an account.
 * Reuses the shared OAuth client + per-account token store via getAuthClient.
 * Caches the built client per account with a 50-min TTL.
 */
export async function getDocsClient(account?: string | AccountConfig): Promise<docs_v1.Docs> {
  const resolved = typeof account === 'string' || account === undefined
    ? resolveAccount(account)
    : account;

  const cacheKey = resolved.email;
  const cached = CLIENT_CACHE.get(cacheKey);

  if (cached && Date.now() < cached.expiresAt) {
    return cached.docs;
  }

  const authClient = await getAuthClient(resolved);
  const docs = google.docs({ version: 'v1', auth: authClient });

  CLIENT_CACHE.set(cacheKey, {
    client: authClient,
    docs,
    expiresAt: Date.now() + CLIENT_TTL_MS,
  });

  return docs;
}
