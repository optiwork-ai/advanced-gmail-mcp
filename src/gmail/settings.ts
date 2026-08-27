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
 * 2. **It works with or without the settings scope.** `sendAs.list` is
 *    documented as a settings call, but it was verified working against the
 *    tokens already on disk under the Gmail scopes alone — which is why Phase 1
 *    shipped the signature feature without asking anyone to re-consent.
 *    `gmail.settings.basic` IS now requested (auth.ts, 2026-08-27) for the mail
 *    rule and vacation tools, so once an alias re-consents this lookup stops
 *    leaning on observed behaviour and becomes properly scoped. Nothing about
 *    the call or the fallback changes either way: a 403 costs a signature, never
 *    a send. Do not move it inside `withRetry`, and do not make composition
 *    depend on the new grant — accounts that have not re-consented must keep
 *    sending exactly as they do today.
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

/**
 * A FAILED lookup is cached far more briefly. Caching a failure for the full 50
 * minutes meant one transient error — a network blip, a momentary 5xx — stripped
 * the display name and the signature from every message sent for the rest of the
 * window, silently. A short negative TTL keeps a hard outage from re-querying on
 * every single send without blinding the sender for an hour.
 */
const PROFILE_FAILURE_TTL_MS = 60 * 1000;

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
  let failed = false;
  try {
    // Deliberately NOT inside withRetry — see the module comment. The call is
    // unchanged now that gmail.settings.basic is requested: it already works on
    // the existing grants, and once an alias re-consents it is simply covered by
    // the scope it is documented under.
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
    failed = true;
  }

  const ttl = failed ? PROFILE_FAILURE_TTL_MS : PROFILE_TTL_MS;
  PROFILE_CACHE.set(key, { profile, expiresAt: Date.now() + ttl });
  return profile;
}
