/**
 * Tests for the missing-scope rewriter.
 *
 * The module's whole job is to replace a bare 403 with "this permission was
 * never granted, run this command". That is the right answer for a token that
 * predates a scope, and the WRONG answer for every other 403 a Google API
 * emits — a full Drive, an exhausted rate limit, a Workspace policy block. The
 * cases below pin both halves: the rewrite fires on a scope-shaped failure and
 * on nothing else.
 */
import { describe, expect, it } from 'vitest';
import { errorStatus, googleErrorReasons, isMissingScopeError, withScopeHint } from './scope-error.js';

const ctx = {
  tool: 'upload_drive_file',
  scope: 'https://www.googleapis.com/auth/drive.file',
  alias: 'test',
};

/** The shape gaxios hands back: a message plus the parsed error body. */
function googleError(status: number, message: string, reason?: string): Error {
  return Object.assign(new Error(message), {
    code: status,
    response: {
      status,
      data: {
        error: {
          code: status,
          message,
          ...(reason ? { errors: [{ reason, message }] } : {}),
        },
      },
    },
  });
}

describe('errorStatus', () => {
  it('reads a numeric code, a response status, and a rewritten message', () => {
    expect(errorStatus(Object.assign(new Error('x'), { code: 403 }))).toBe(403);
    expect(errorStatus({ response: { status: 401 } })).toBe(401);
    expect(errorStatus(new Error('Authentication error (403): Insufficient Permission'))).toBe(403);
    expect(errorStatus(new Error('plain failure'))).toBeUndefined();
  });

  it('is not fooled by a string code, which gaxios can set from an underlying error', () => {
    const err = Object.assign(new Error('boom'), {
      code: 'ERR_BAD_REQUEST',
      response: { status: 403 },
    });
    expect(errorStatus(err)).toBe(403);
  });
});

describe('googleErrorReasons', () => {
  it('collects reasons from the flat and nested shapes and the status string', () => {
    expect(googleErrorReasons(googleError(403, 'nope', 'insufficientPermissions')))
      .toContain('insufficientpermissions');
    expect(googleErrorReasons(Object.assign(new Error('x'), {
      errors: [{ reason: 'rateLimitExceeded' }],
    }))).toContain('ratelimitexceeded');
    expect(googleErrorReasons(Object.assign(new Error('x'), {
      response: { data: { error: { status: 'PERMISSION_DENIED' } } },
    }))).toContain('permission_denied');
    expect(googleErrorReasons(new Error('nothing structured'))).toEqual([]);
  });
});

describe('isMissingScopeError', () => {
  it('is true for the scope-shaped failures Google actually emits', () => {
    expect(isMissingScopeError(googleError(403, 'Request had insufficient authentication scopes.')))
      .toBe(true);
    expect(isMissingScopeError(googleError(403, 'Insufficient Permission', 'insufficientPermissions')))
      .toBe(true);
    expect(isMissingScopeError(googleError(401, 'Unauthorized', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT')))
      .toBe(true);
    // withRetry rewrites the error before a caller sees it; the wording survives.
    expect(isMissingScopeError(new Error('Authentication error (403): Insufficient Permission')))
      .toBe(true);
  });

  // R2-C4: the check tested only the status, so every 403 became "you are
  // missing this scope" and the true cause survived only after "Original error:".
  it('is FALSE for a 403 that is not about scopes at all', () => {
    expect(isMissingScopeError(googleError(
      403,
      "The user's Drive storage quota has been exceeded.",
      'storageQuotaExceeded',
    ))).toBe(false);
    expect(isMissingScopeError(googleError(
      403,
      'Rate Limit Exceeded',
      'rateLimitExceeded',
    ))).toBe(false);
    expect(isMissingScopeError(googleError(
      403,
      'The domain policy has disabled third-party Drive apps.',
      'domainPolicy',
    ))).toBe(false);
    expect(isMissingScopeError(googleError(404, 'File not found.'))).toBe(false);
  });
});

describe('withScopeHint', () => {
  it('rewrites a scope failure into the re-consent instruction', async () => {
    await expect(withScopeHint(ctx, async () => {
      throw googleError(403, 'Request had insufficient authentication scopes.');
    })).rejects.toThrow(/upload_drive_file needs the .*drive\.file scope/);
  });

  it('passes a quota 403 through with its own message and no scope advice', async () => {
    const failure = withScopeHint(ctx, async () => {
      throw googleError(403, "The user's Drive storage quota has been exceeded.", 'storageQuotaExceeded');
    });
    await expect(failure).rejects.toThrow(/storage quota has been exceeded/);
    await expect(failure).rejects.not.toThrow(/npm run auth/);
  });

  it('passes an exhausted rate limit through rather than blaming the grant', async () => {
    const failure = withScopeHint(ctx, async () => {
      throw googleError(403, 'Rate Limit Exceeded', 'rateLimitExceeded');
    });
    await expect(failure).rejects.toThrow(/Rate Limit Exceeded/);
    await expect(failure).rejects.not.toThrow(/does not carry it/);
  });

  it('returns the value when nothing fails', async () => {
    await expect(withScopeHint(ctx, async () => 'ok')).resolves.toBe('ok');
  });
});
