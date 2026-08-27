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

/** True for the 401/403 shape that a missing grant produces. */
export function isMissingScopeError(err: unknown): boolean {
  const status = errorStatus(err);
  return status === 401 || status === 403;
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
