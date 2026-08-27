import { describe, expect, it, vi } from 'vitest';
import type { gmail_v1 } from 'googleapis';
import {
  buildForwardSubject,
  buildReferences,
  buildReplyCc,
  buildReplyRecipients,
  buildReplySubject,
  encodeHeaderValue,
  extractBody,
  parseUnsubscribeHeaders,
  withRetry,
} from './client.js';

function b64(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url');
}

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

describe('buildReplySubject', () => {
  it('prepends Re: when not already prefixed', () => {
    expect(buildReplySubject('Hello')).toBe('Re: Hello');
  });

  it('preserves an existing Re: prefix', () => {
    expect(buildReplySubject('Re: Hello')).toBe('Re: Hello');
  });

  it('is case-insensitive when checking the prefix', () => {
    expect(buildReplySubject('RE: Hello')).toBe('RE: Hello');
    expect(buildReplySubject('re: Hello')).toBe('re: Hello');
  });

  it('handles an empty subject', () => {
    expect(buildReplySubject('')).toBe('Re: ');
  });
});

describe('buildReferences', () => {
  it('returns just the messageId when no prior references', () => {
    expect(buildReferences('', '<abc@host>')).toBe('<abc@host>');
  });

  it('appends the messageId when prior references exist', () => {
    expect(buildReferences('<a@h> <b@h>', '<c@h>')).toBe('<a@h> <b@h> <c@h>');
  });
});

describe('buildReplyCc', () => {
  it('returns undefined when reply_all is false and no userCc', () => {
    expect(buildReplyCc({
      selfEmail: 'me@x.com',
      originalTo: 'alice@x.com',
      originalCc: 'bob@x.com',
    })).toBeUndefined();
  });

  it('passes through a user-provided cc unchanged when not reply-all', () => {
    expect(buildReplyCc({
      selfEmail: 'me@x.com',
      originalTo: 'alice@x.com',
      originalCc: '',
      userCc: 'carol@x.com',
    })).toBe('carol@x.com');
  });

  it('reply_all includes originalTo and originalCc but excludes self', () => {
    expect(buildReplyCc({
      selfEmail: 'me@x.com',
      originalTo: 'alice@x.com, me@x.com',
      originalCc: 'bob@x.com',
      replyAll: true,
    })).toBe('alice@x.com, bob@x.com');
  });

  it('reply_all dedups duplicate addresses across To and Cc', () => {
    expect(buildReplyCc({
      selfEmail: 'me@x.com',
      originalTo: 'alice@x.com',
      originalCc: 'alice@x.com, bob@x.com',
      replyAll: true,
    })).toBe('alice@x.com, bob@x.com');
  });

  it('reply_all preserves "Name <email>" formatting', () => {
    expect(buildReplyCc({
      selfEmail: 'me@x.com',
      originalTo: 'Alice <alice@x.com>',
      originalCc: '',
      replyAll: true,
    })).toBe('Alice <alice@x.com>');
  });

  it('dedups user-provided cc against reply-all set', () => {
    expect(buildReplyCc({
      selfEmail: 'me@x.com',
      originalTo: 'alice@x.com',
      originalCc: '',
      userCc: 'alice@x.com, dave@x.com',
      replyAll: true,
    })).toBe('alice@x.com, dave@x.com');
  });

  it('is case-insensitive in the self-dedup', () => {
    expect(buildReplyCc({
      selfEmail: 'Me@X.com',
      originalTo: 'me@x.com, alice@x.com',
      originalCc: '',
      replyAll: true,
    })).toBe('alice@x.com');
  });
});

describe('buildForwardSubject', () => {
  it('prepends Fwd: when not already prefixed', () => {
    expect(buildForwardSubject('Hello')).toBe('Fwd: Hello');
  });

  it('preserves an existing Fwd: prefix', () => {
    expect(buildForwardSubject('Fwd: Hello')).toBe('Fwd: Hello');
  });

  it('preserves Fw: prefix (alternate variant)', () => {
    expect(buildForwardSubject('Fw: Hello')).toBe('Fw: Hello');
  });

  it('is case-insensitive', () => {
    expect(buildForwardSubject('FWD: Hello')).toBe('FWD: Hello');
  });
});

// buildForwardBody was replaced by mime.ts's buildForwardBlock, which emits
// both an HTML and a text flavour; its suite lives in mime.test.ts.

describe('buildReplyRecipients', () => {
  const base = {
    selfEmail: 'me@x.com',
    originalFrom: 'Alice <alice@x.com>',
    originalTo: 'me@x.com, bob@x.com',
    originalCc: 'carol@x.com',
  };

  it('addresses the original sender when there is no Reply-To', () => {
    expect(buildReplyRecipients(base)).toEqual({
      to: 'Alice <alice@x.com>',
      cc: undefined,
    });
  });

  it('addresses Reply-To instead of From when the original set one', () => {
    expect(
      buildReplyRecipients({ ...base, originalReplyTo: 'Support <support@x.com>' }).to,
    ).toBe('Support <support@x.com>');
  });

  it('ignores a blank Reply-To', () => {
    expect(buildReplyRecipients({ ...base, originalReplyTo: '   ' }).to).toBe(
      'Alice <alice@x.com>',
    );
  });

  it('reply-all keeps the original To in To and the original Cc in Cc, minus self', () => {
    expect(buildReplyRecipients({ ...base, replyAll: true })).toEqual({
      to: 'Alice <alice@x.com>, bob@x.com',
      cc: 'carol@x.com',
    });
  });

  it('reply-all dedups an address appearing in both To and Cc', () => {
    expect(
      buildReplyRecipients({
        ...base,
        originalCc: 'bob@x.com, carol@x.com',
        replyAll: true,
      }).cc,
    ).toBe('carol@x.com');
  });

  it('never duplicates the sender into the reply-all To list', () => {
    expect(
      buildReplyRecipients({
        ...base,
        originalTo: 'alice@x.com, bob@x.com',
        replyAll: true,
      }).to,
    ).toBe('Alice <alice@x.com>, bob@x.com');
  });

  it('adds a caller-supplied cc without reply-all', () => {
    expect(buildReplyRecipients({ ...base, userCc: 'dave@x.com' })).toEqual({
      to: 'Alice <alice@x.com>',
      cc: 'dave@x.com',
    });
  });

  it('dedups a caller-supplied cc against the reply-all set', () => {
    expect(
      buildReplyRecipients({ ...base, userCc: 'carol@x.com, dave@x.com', replyAll: true }).cc,
    ).toBe('carol@x.com, dave@x.com');
  });

  it('is case-insensitive in the self-exclusion', () => {
    expect(
      buildReplyRecipients({
        ...base,
        selfEmail: 'Me@X.com',
        originalTo: 'ME@x.com, bob@x.com',
        replyAll: true,
      }).to,
    ).toBe('Alice <alice@x.com>, bob@x.com');
  });

  it('still addresses the sender when replying to your own message', () => {
    expect(
      buildReplyRecipients({
        selfEmail: 'me@x.com',
        originalFrom: 'me@x.com',
        originalTo: 'alice@x.com',
        originalCc: '',
      }).to,
    ).toBe('me@x.com');
  });

  it('preserves "Name <email>" formatting', () => {
    expect(
      buildReplyRecipients({
        ...base,
        originalTo: 'Bob Jones <bob@x.com>',
        replyAll: true,
      }).to,
    ).toBe('Alice <alice@x.com>, Bob Jones <bob@x.com>');
  });
});

describe('extractBody', () => {
  it('reads a single-part text/plain payload', () => {
    const payload: gmail_v1.Schema$MessagePart = {
      mimeType: 'text/plain',
      body: { data: b64('hello') },
    };
    expect(extractBody(payload)).toEqual({ html: '', text: 'hello' });
  });

  it('reads both parts of a multipart/alternative', () => {
    const payload: gmail_v1.Schema$MessagePart = {
      mimeType: 'multipart/alternative',
      parts: [
        { mimeType: 'text/plain', body: { data: b64('plain') } },
        { mimeType: 'text/html', body: { data: b64('<p>html</p>') } },
      ],
    };
    expect(extractBody(payload)).toEqual({ html: '<p>html</p>', text: 'plain' });
  });

  it('is first-wins: a nested alternative does not overwrite the top-level body', () => {
    const payload: gmail_v1.Schema$MessagePart = {
      mimeType: 'multipart/mixed',
      parts: [
        {
          mimeType: 'multipart/alternative',
          parts: [
            { mimeType: 'text/plain', body: { data: b64('top level') } },
            { mimeType: 'text/html', body: { data: b64('<p>top level</p>') } },
          ],
        },
        {
          mimeType: 'multipart/alternative',
          parts: [
            { mimeType: 'text/plain', body: { data: b64('later part') } },
            { mimeType: 'text/html', body: { data: b64('<p>later part</p>') } },
          ],
        },
      ],
    };
    expect(extractBody(payload)).toEqual({ html: '<p>top level</p>', text: 'top level' });
  });

  it('does not descend into a message/rfc822 sub-message (defect F5)', () => {
    const payload: gmail_v1.Schema$MessagePart = {
      mimeType: 'multipart/mixed',
      parts: [
        { mimeType: 'text/plain', body: { data: b64('my forward note') } },
        {
          mimeType: 'message/rfc822',
          parts: [
            { mimeType: 'text/plain', body: { data: b64('the nested original') } },
            { mimeType: 'text/html', body: { data: b64('<p>the nested original</p>') } },
          ],
        },
      ],
    };
    expect(extractBody(payload)).toEqual({ html: '', text: 'my forward note' });
  });

  it('ignores a text/* part that is actually an attachment', () => {
    const payload: gmail_v1.Schema$MessagePart = {
      mimeType: 'multipart/mixed',
      parts: [
        { mimeType: 'text/plain', body: { data: b64('real body') } },
        {
          mimeType: 'text/csv',
          filename: 'data.csv',
          body: { data: b64('a,b\n1,2'), attachmentId: 'att1' },
        },
        {
          mimeType: 'text/plain',
          filename: 'notes.txt',
          body: { data: b64('attached notes'), attachmentId: 'att2' },
        },
      ],
    };
    expect(extractBody(payload)).toEqual({ html: '', text: 'real body' });
  });

  it('returns empty strings for a payload with no body parts', () => {
    expect(extractBody({ mimeType: 'multipart/mixed', parts: [] })).toEqual({
      html: '',
      text: '',
    });
  });
});

describe('encodeHeaderValue', () => {
  it('returns ASCII values unchanged', () => {
    expect(encodeHeaderValue('Hello world')).toBe('Hello world');
  });

  it('returns an empty string unchanged', () => {
    expect(encodeHeaderValue('')).toBe('');
  });

  it('preserves punctuation and digits as ASCII', () => {
    expect(encodeHeaderValue('Re: Order #1234 — confirmation!')).toBe(
      // The em-dash is non-ASCII, so the whole value gets encoded.
      '=?UTF-8?B?UmU6IE9yZGVyICMxMjM0IOKAlCBjb25maXJtYXRpb24h?=',
    );
  });

  it('encodes emoji as RFC 2047 base64 encoded-word', () => {
    const encoded = encodeHeaderValue('Hello 👋');
    expect(encoded).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    // Decode and verify round-trip.
    const b64 = encoded.replace(/^=\?UTF-8\?B\?/, '').replace(/\?=$/, '');
    expect(Buffer.from(b64, 'base64').toString('utf-8')).toBe('Hello 👋');
  });

  it('encodes accented Latin characters', () => {
    const encoded = encodeHeaderValue('Café — déjà vu');
    expect(encoded.startsWith('=?UTF-8?B?')).toBe(true);
    const b64 = encoded.replace(/^=\?UTF-8\?B\?/, '').replace(/\?=$/, '');
    expect(Buffer.from(b64, 'base64').toString('utf-8')).toBe('Café — déjà vu');
  });

  it('encodes CJK characters', () => {
    const encoded = encodeHeaderValue('日本語');
    const b64 = encoded.replace(/^=\?UTF-8\?B\?/, '').replace(/\?=$/, '');
    expect(Buffer.from(b64, 'base64').toString('utf-8')).toBe('日本語');
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
