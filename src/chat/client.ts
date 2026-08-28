import { google } from 'googleapis';
import type { chat_v1 } from 'googleapis';
import type { Auth } from 'googleapis';
import { type AccountConfig, resolveAccount } from '../config.js';
import { getAuthClient } from '../gmail/auth.js';

// ---------------------------------------------------------------------------
// Client cache: Google Chat API client per account with 50-min TTL.
// Mirrors the caching idiom in src/gmail/client.ts.
//
// This module was read-only until 2026-08-28, when the owner withdrew that
// posture ("lets get chat posting working as well"). The one mutating call
// this server makes is `spaces.messages.create`, behind `post_chat_message`.
// Nothing here updates or deletes a message, and no scope for either is
// requested.
// ---------------------------------------------------------------------------

interface CachedClient {
  client: Auth.OAuth2Client;
  chat: chat_v1.Chat;
  expiresAt: number;
}

const CLIENT_CACHE = new Map<string, CachedClient>();
const CLIENT_TTL_MS = 50 * 60 * 1000; // 50 minutes

/**
 * The scopes the Chat calls need, named here so a missing-scope error can quote
 * the exact one back at the caller (see `src/google-api-error.ts`).
 */
export const CHAT_SPACES_SCOPE = 'https://www.googleapis.com/auth/chat.spaces.readonly';
export const CHAT_MESSAGES_SCOPE = 'https://www.googleapis.com/auth/chat.messages.readonly';
/**
 * Posting. Deliberately separate from the two read scopes above: a token can
 * carry the read pair and still be unable to post, which is precisely the case
 * every alias is in until it re-consents after 2026-08-28.
 */
export const CHAT_MESSAGES_CREATE_SCOPE = 'https://www.googleapis.com/auth/chat.messages.create';

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
