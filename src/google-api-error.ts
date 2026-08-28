/**
 * Honest failures for every non-Gmail Google API this server calls.
 *
 * `withRetry` is the Gmail client's retry helper, and it rewrites EVERY
 * non-rate-limit 401/403 into "Authentication error (403) … Re-authenticate
 * with: npx tsx src/auth.ts". Inside Gmail that is usually right. For Chat,
 * Drive, Docs and Calendar it usually is not: the 403s those APIs actually
 * produce are "this API was never enabled on the Cloud project", "this token
 * was never granted that scope", and "you do not have access to this
 * space / file / document". None of them is a broken login, and being told to
 * re-authenticate sends the reader round a loop that cannot fix any of them
 * while the real cause survives only in the tail after "Original error:".
 *
 * W13 (fa6d6dd) built this for Calendar. This module is that same translator
 * with the service name lifted into the context, so the four read-only
 * Chat/Drive/Docs tools get it without a fourth and fifth copy of the logic,
 * and `translateCalendarError` becomes a one-line delegation.
 *
 * Layering: this imports `withRetry`/`isRateLimit403` from the Gmail client and
 * the error vocabulary from `scope-error.ts`. `scope-error.ts` still imports
 * nothing, so there is no cycle.
 */
import { isRateLimit403, withRetry } from './gmail/client.js';
import {
  type ScopeErrorContext,
  errorStatus,
  googleErrorReasons,
  isMissingScopeError,
  scopeError,
} from './scope-error.js';

export interface GoogleApiErrorContext extends ScopeErrorContext {
  /**
   * The API's human name, exactly as it should read in a sentence and as
   * Google's own console calls it — "Google Chat", "Google Drive",
   * "Google Docs", "Google Calendar".
   */
  api: string;
}

/** Google's own words for "this project never turned the API on". */
const API_DISABLED_RE = /has not been used in project|api is disabled|is not enabled/i;

/**
 * Turn a Google API failure into advice that is actually true. Returns the
 * error to throw:
 *
 * - a missing scope becomes the shared `scopeError` — naming the scope and the
 *   exact `npm run auth -- <alias>` that grants it;
 * - an accessNotConfigured 403 says to enable the API in the Cloud console, and
 *   says plainly that re-authenticating will not help;
 * - a rate-limit 403 is returned UNTOUCHED, so `withRetry` still retries it and
 *   the caller ends up with Google's own rate-limit words;
 * - any other 403 is restated honestly, without re-auth advice;
 * - everything else — 401 included, where re-authenticating IS the fix — is
 *   returned untouched.
 *
 * It must run INSIDE `withRetry`, on the raw Google error, because the reason
 * codes that tell these cases apart do not survive the rewrite.
 */
export function translateGoogleApiError(err: unknown, ctx: GoogleApiErrorContext): unknown {
  if (isMissingScopeError(err)) return scopeError(err, ctx);

  const status = errorStatus(err);
  if (status !== 403) return err;
  if (isRateLimit403(status, err)) return err;

  const original = err instanceof Error ? err.message : String(err);
  const reasons = googleErrorReasons(err);

  if (reasons.includes('accessnotconfigured') || API_DISABLED_RE.test(original)) {
    return new Error(
      `${ctx.tool}: the ${ctx.api} API is not enabled for the Cloud project behind this `
      + `server's credentials. Enable it in the Google Cloud console (the link in the original `
      + `error below goes straight there), then retry. Re-authenticating "${ctx.alias}" will not `
      + `help — the token is fine, the API is switched off.\n\nOriginal error: ${original}`,
    );
  }

  return new Error(
    `${ctx.tool}: Google refused this ${ctx.api} request (403) for "${ctx.alias}". This is a `
    + `permission on the resource or the project, not a broken login, so re-authenticating is `
    + `unlikely to change it.\n\nOriginal error: ${original}`,
  );
}

/**
 * Run one Google API call with retries AND honest error reporting.
 * The translation sits inside the retry so it reads the raw Google error.
 */
export async function googleApiCall<T>(
  ctx: GoogleApiErrorContext,
  fn: () => Promise<T>,
): Promise<T> {
  return withRetry(async () => {
    try {
      return await fn();
    } catch (err: unknown) {
      throw translateGoogleApiError(err, ctx);
    }
  });
}
