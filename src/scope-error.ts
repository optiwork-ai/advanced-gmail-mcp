/**
 * Turn a missing-scope 401/403 into an instruction the caller can act on.
 *
 * Two write scopes were added on 2026-08-27 (`drive.file`,
 * `gmail.settings.basic`). Adding a scope to `auth.ts` does NOT change any
 * token already on disk: every alias keeps the grants it consented to until it
 * is re-run through the auth flow. So until each alias re-consents, the tools
 * that need a new scope answer 403 — and the generic message they would
 * otherwise carry ("Authentication error (403) … Re-authenticate") reads like
 * a broken login rather than "this specific permission was never granted".
 *
 * `withRetry` has usually already rewritten the raw Google error by the time a
 * caller sees it, so the status is recovered from either the raw error shape or
 * that rewritten message.
 */

export interface ScopeErrorContext {
  /** The MCP tool name the user invoked, e.g. `upload_drive_file`. */
  tool: string;
  /** The OAuth scope the call needs, e.g. `.../auth/drive.file`. */
  scope: string;
  /** Account alias, so the re-consent command can be stated exactly. */
  alias: string;
}

/** Recover the HTTP status from a raw Google error or a rewritten one. */
export function errorStatus(err: unknown): number | undefined {
  const e = err as { code?: unknown; response?: { status?: unknown } };
  if (typeof e?.code === 'number') return e.code;
  if (typeof e?.response?.status === 'number') return e.response.status;

  const message = err instanceof Error ? err.message : '';
  const rewritten = /^Authentication error \((\d{3})\)/.exec(message);
  if (rewritten) return Number(rewritten[1]);
  return undefined;
}

/**
 * Collect the `reason` strings a Google API error carries, lowercased.
 *
 * Google puts them in two places depending on the API and the client version —
 * a flat `errors[]` on the error itself and a nested one under
 * `response.data.error` — plus a `status` enum on the nested body. This lives
 * here rather than in the Gmail client because it is the shared vocabulary for
 * reading a Google failure, and this module imports nothing.
 */
export function googleErrorReasons(err: unknown): string[] {
  const e = err as {
    errors?: Array<{ reason?: string }>;
    response?: { data?: { error?: { errors?: Array<{ reason?: string }>; status?: string } } };
  };
  const reasons: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value === 'string' && value.length > 0) reasons.push(value.toLowerCase());
  };

  if (Array.isArray(e?.errors)) {
    for (const item of e.errors) push(item?.reason);
  }
  const nested = e?.response?.data?.error;
  if (Array.isArray(nested?.errors)) {
    for (const item of nested.errors) push(item?.reason);
  }
  push(nested?.status);

  return reasons;
}

/** The reasons and phrasings Google uses when a token lacks a required scope. */
const SCOPE_REASONS = new Set([
  'insufficientpermissions',
  'access_token_scope_insufficient',
  'insufficientscopes',
]);
const SCOPE_PHRASES = /insufficient (authentication )?(scopes?|permissions?)|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i;

/**
 * True for the 401/403 shape that a MISSING GRANT produces — and only that.
 *
 * The status alone is not enough. Google answers 403 for a full Drive, for a
 * rate limit that outlived the retries, and for a Workspace policy block, and
 * rewriting those into "the token does not carry this scope, run npm run auth"
 * sends the reader to fix something that is not broken while the real cause
 * survives only in the tail after "Original error:". Today that mistake is
 * almost always harmless, because no token carries either new scope; it turns
 * wrong for every genuine 403 the moment the accounts re-consent, which is
 * exactly when someone will act on it.
 */
export function isMissingScopeError(err: unknown): boolean {
  const status = errorStatus(err);
  if (status !== 401 && status !== 403) return false;

  if (googleErrorReasons(err).some(reason => SCOPE_REASONS.has(reason))) return true;

  const message = err instanceof Error ? err.message : String(err);
  return SCOPE_PHRASES.test(message);
}

/**
 * Build the error to throw in place of a bare 403: name the tool, the scope
 * and the exact command that fixes it, and keep the original message.
 */
export function scopeError(err: unknown, ctx: ScopeErrorContext): Error {
  const original = err instanceof Error ? err.message : String(err);
  return new Error(
    `${ctx.tool} needs the ${ctx.scope} scope, and the token for "${ctx.alias}" does not carry it.\n\n`
    + `This is expected until the account re-consents: adding a scope does not change a token `
    + `that was already issued. Grant it with:\n\n`
    + `    npm run auth -- ${ctx.alias}\n\n`
    + `Then retry. Original error: ${original}`,
  );
}

/**
 * Run `fn`, converting a missing-scope 401/403 into the actionable message.
 * Every other failure propagates untouched — this must never swallow an error.
 */
export async function withScopeHint<T>(
  ctx: ScopeErrorContext,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err: unknown) {
    if (isMissingScopeError(err)) throw scopeError(err, ctx);
    throw err;
  }
}
