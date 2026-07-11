import { google } from 'googleapis';
import type { chat_v1 } from 'googleapis';
import type { Auth } from 'googleapis';
import { type AccountConfig, resolveAccount } from '../config.js';
import { getAuthClient } from '../gmail/auth.js';

// ---------------------------------------------------------------------------
// Client cache: Google Chat API client per account with 50-min TTL.
// Mirrors the caching idiom in src/gmail/client.ts. READ-ONLY use only —
// callers must never invoke a mutating Chat method (create/update/delete).
// ---------------------------------------------------------------------------

interface CachedClient {
  client: Auth.OAuth2Client;
  chat: chat_v1.Chat;
  expiresAt: number;
}

const CLIENT_CACHE = new Map<string, CachedClient>();
const CLIENT_TTL_MS = 50 * 60 * 1000; // 50 minutes

/**
 * Get an authenticated Google Chat API client for an account.
 * Reuses the shared OAuth client + per-account token store via getAuthClient.
 * Caches the built client per account with a 50-min TTL.
 */
export async function getChatClient(account?: string | AccountConfig): Promise<chat_v1.Chat> {
  const resolved = typeof account === 'string' || account === undefined
    ? resolveAccount(account)
    : account;

  const cacheKey = resolved.email;
  const cached = CLIENT_CACHE.get(cacheKey);

  if (cached && Date.now() < cached.expiresAt) {
    return cached.chat;
  }

  const authClient = await getAuthClient(resolved);
  const chat = google.chat({ version: 'v1', auth: authClient });

  CLIENT_CACHE.set(cacheKey, {
    client: authClient,
    chat,
    expiresAt: Date.now() + CLIENT_TTL_MS,
  });

  return chat;
}
