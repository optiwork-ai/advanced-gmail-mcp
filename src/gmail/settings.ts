/**
 * Cached `users.settings.sendAs` lookup — the account's display name, its
 * Gmail signature, and any configured reply-to.
 *
 * Two rules govern this module:
 *
 * 1. **It never fails a send.** Every call is wrapped in its own try/catch and
 *    degrades to an empty profile. In particular it must NOT go through
 *    `withRetry`, which rewrites any 401/403 into a fatal re-auth error — a
 *    signature lookup on a narrowly-scoped token would otherwise kill an
 *    otherwise-valid message (review-outbound.md defect R4).
 * 2. **It needs no new scopes.** `sendAs.list` was verified working against the
 *    tokens already on disk under the scopes granted in `auth.ts`. Do not add
 *    `gmail.settings.basic` and do not force a re-consent.
 */
import type { gmail_v1 } from 'googleapis';
import type { AccountConfig } from '../config.js';
import { log } from '../log.js';
import type { SendAsProfile } from './types.js';

export type { SendAsProfile };

interface CachedProfile {
  profile: SendAsProfile;
  expiresAt: number;
}

const PROFILE_CACHE = new Map<string, CachedProfile>();

/** Mirrors the OAuth client cache TTL in client.ts. */
const PROFILE_TTL_MS = 50 * 60 * 1000;

/** Reset the cache. Test seam only. */
export function clearSendAsCache(): void {
  PROFILE_CACHE.clear();
}

function emptyProfile(email: string): SendAsProfile {
  return { email, displayName: '', signatureHtml: '', replyTo: '' };
}

function pickSendAs(
  entries: gmail_v1.Schema$SendAs[],
  accountEmail: string,
): gmail_v1.Schema$SendAs | undefined {
  return (
    entries.find(e => e.isDefault === true)
    ?? entries.find(e => e.isPrimary === true)
    ?? entries.find(
      e => (e.sendAsEmail ?? '').toLowerCase() === accountEmail.toLowerCase(),
    )
  );
}

/**
 * Fetch (and cache) the sendAs profile for an account.
 * Any failure returns an empty profile — a missing signature is never fatal.
 */
export async function getSendAsProfile(
  account: AccountConfig,
  gmail: gmail_v1.Gmail,
): Promise<SendAsProfile> {
  const key = account.email.toLowerCase();
  const cached = PROFILE_CACHE.get(key);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.profile;
  }

  let profile: SendAsProfile;
  try {
    // Deliberately NOT inside withRetry — see the module comment.
    const response = await gmail.users.settings.sendAs.list({ userId: 'me' });
    const entry = pickSendAs(response.data.sendAs ?? [], account.email);
    profile = entry
      ? {
          email: entry.sendAsEmail || account.email,
          displayName: entry.displayName || '',
          signatureHtml: entry.signature || '',
          replyTo: entry.replyToAddress || '',
        }
      : emptyProfile(account.email);
  } catch (err: unknown) {
    const status = (err as { code?: number; response?: { status?: number } })?.code
      ?? (err as { response?: { status?: number } })?.response?.status;
    log('warn', 'sendas_unavailable', { account: account.alias, status });
    profile = emptyProfile(account.email);
  }

  PROFILE_CACHE.set(key, { profile, expiresAt: Date.now() + PROFILE_TTL_MS });
  return profile;
}
