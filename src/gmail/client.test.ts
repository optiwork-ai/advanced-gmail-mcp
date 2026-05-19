import { describe, expect, it } from 'vitest';
import { parseUnsubscribeHeaders } from './client.js';

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
