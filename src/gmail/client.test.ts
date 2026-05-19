import { describe, expect, it, vi } from 'vitest';
import { parseUnsubscribeHeaders, withRetry } from './client.js';

function statusError(status: number, message = 'fail'): Error & { code?: number } {
  const err = new Error(message) as Error & { code?: number };
  err.code = status;
  return err;
}

describe('withRetry', () => {
  it('returns the value on the first attempt when fn succeeds', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const sleep = vi.fn();
    await expect(withRetry(fn, { sleep })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries on 429 and succeeds', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(statusError(429))
      .mockResolvedValue('ok');
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(withRetry(fn, { sleep })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it.each([500, 502, 503, 504])('retries on %i and succeeds', async (status) => {
    const fn = vi.fn()
      .mockRejectedValueOnce(statusError(status))
      .mockResolvedValue('ok');
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(withRetry(fn, { sleep })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not retry on 400', async () => {
    const fn = vi.fn().mockRejectedValue(statusError(400));
    const sleep = vi.fn();
    await expect(withRetry(fn, { sleep })).rejects.toMatchObject({ code: 400 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('rewrites 401 to a re-auth instruction', async () => {
    const fn = vi.fn().mockRejectedValue(statusError(401, 'token bad'));
    await expect(withRetry(fn, { sleep: vi.fn() })).rejects.toThrow(/Re-authenticate/);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('rewrites 403 to a re-auth instruction', async () => {
    const fn = vi.fn().mockRejectedValue(statusError(403, 'scope bad'));
    await expect(withRetry(fn, { sleep: vi.fn() })).rejects.toThrow(/Re-authenticate/);
  });

  it('exhausts retries and re-throws the last error', async () => {
    const fn = vi.fn().mockRejectedValue(statusError(503));
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(withRetry(fn, { sleep, maxRetries: 2 })).rejects.toMatchObject({ code: 503 });
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('uses exponential backoff: 1s, 2s, 4s', async () => {
    const fn = vi.fn().mockRejectedValue(statusError(503));
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(withRetry(fn, { sleep, maxRetries: 3 })).rejects.toBeDefined();
    expect(sleep).toHaveBeenNthCalledWith(1, 1000);
    expect(sleep).toHaveBeenNthCalledWith(2, 2000);
    expect(sleep).toHaveBeenNthCalledWith(3, 4000);
  });

  it('reads status from response.status as well as code', async () => {
    const err: any = new Error('fail');
    err.response = { status: 503 };
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValue('ok');
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(withRetry(fn, { sleep })).resolves.toBe('ok');
  });
});

describe('parseUnsubscribeHeaders', () => {
  it('returns empty result when header is missing', () => {
    expect(parseUnsubscribeHeaders('', '')).toEqual({
      httpsUrls: [],
      mailto: null,
      canOneClick: false,
    });
  });

  it('parses a single mailto entry', () => {
    const result = parseUnsubscribeHeaders('<mailto:unsub@example.com>', '');
    expect(result.mailto).toEqual({
      address: 'unsub@example.com',
      subject: 'Unsubscribe',
      body: 'Unsubscribe',
    });
    expect(result.httpsUrls).toEqual([]);
    expect(result.canOneClick).toBe(false);
  });

  it('parses mailto with subject and body query params', () => {
    const result = parseUnsubscribeHeaders(
      '<mailto:list@example.com?subject=unsub-token-abc&body=please+remove+me>',
      '',
    );
    expect(result.mailto).toEqual({
      address: 'list@example.com',
      subject: 'unsub-token-abc',
      body: 'please remove me',
    });
  });

  it('parses a single HTTPS entry without one-click', () => {
    const result = parseUnsubscribeHeaders('<https://example.com/unsub?id=abc>', '');
    expect(result.httpsUrls).toEqual(['https://example.com/unsub?id=abc']);
    expect(result.mailto).toBeNull();
    expect(result.canOneClick).toBe(false);
  });

  it('marks canOneClick true when both an HTTPS URL and List-Unsubscribe-Post are present', () => {
    const result = parseUnsubscribeHeaders(
      '<https://example.com/unsub?id=abc>',
      'List-Unsubscribe=One-Click',
    );
    expect(result.canOneClick).toBe(true);
  });

  it('parses combined mailto + HTTPS header', () => {
    const result = parseUnsubscribeHeaders(
      '<mailto:unsub@example.com>, <https://example.com/unsub?id=abc>',
      'List-Unsubscribe=One-Click',
    );
    expect(result.mailto?.address).toBe('unsub@example.com');
    expect(result.httpsUrls).toEqual(['https://example.com/unsub?id=abc']);
    expect(result.canOneClick).toBe(true);
  });

  it('collects multiple HTTPS URLs in order', () => {
    const result = parseUnsubscribeHeaders(
      '<https://a.example.com/u>, <https://b.example.com/u>',
      'List-Unsubscribe=One-Click',
    );
    expect(result.httpsUrls).toEqual([
      'https://a.example.com/u',
      'https://b.example.com/u',
    ]);
  });

  it('keeps only the first mailto when multiple are listed', () => {
    const result = parseUnsubscribeHeaders(
      '<mailto:first@example.com>, <mailto:second@example.com>',
      '',
    );
    expect(result.mailto?.address).toBe('first@example.com');
  });

  it('handles http:// (not just https://) URLs', () => {
    const result = parseUnsubscribeHeaders('<http://legacy.example.com/u>', '');
    expect(result.httpsUrls).toEqual(['http://legacy.example.com/u']);
  });

  it('is case-insensitive on scheme', () => {
    const result = parseUnsubscribeHeaders(
      '<MAILTO:unsub@example.com>, <HTTPS://example.com/u>',
      '',
    );
    expect(result.mailto?.address).toBe('unsub@example.com');
    expect(result.httpsUrls).toEqual(['HTTPS://example.com/u']);
  });

  it('tolerates whitespace inside angle brackets', () => {
    const result = parseUnsubscribeHeaders(
      '< https://example.com/u >',
      'List-Unsubscribe=One-Click',
    );
    expect(result.httpsUrls).toEqual(['https://example.com/u']);
  });
});
