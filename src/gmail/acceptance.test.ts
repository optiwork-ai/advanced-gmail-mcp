/**
 * B10 acceptance gate for the Gmail-native outbound rewrite.
 *
 * These assertions are the contract's unit-level gate (review-outbound.md §B10,
 * steps 2-4, plus the CRLF header-injection item added by BUILD-CONTRACT.md).
 * They are written BEFORE the implementation and must fail against the old
 * single-part builder; they must pass after the rewrite.
 *
 * Step B10.5 (live acceptance sends) is deliberately NOT here — it is run by
 * the chair against real accounts, never by the test suite.
 */
import { describe, expect, it } from 'vitest';
import { buildRawMessage } from './client.js';

function decodeRaw(rawBase64Url: string): string {
  return Buffer.from(rawBase64Url, 'base64url').toString('utf8');
}

describe('B10.2 — a plain-text send is Gmail-native multipart', () => {
  it('assembles multipart/alternative with text and HTML parts and no line over 998 octets', () => {
    const longParagraph = 'x'.repeat(5000);
    const raw = decodeRaw(
      buildRawMessage({
        from: 'steve@appraisalhost.com',
        to: 'someone@example.com',
        subject: 'Gate 2',
        body: `Hello there.\n\n${longParagraph}`,
      }),
    );

    expect(raw).toContain('Content-Type: multipart/alternative');
    expect(raw).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(raw).toContain('Content-Type: text/html; charset="UTF-8"');

    // The HTML alternative must be Gmail's own shape.
    const html = raw
      .split(/\r\n/)
      .filter(line => /^[A-Za-z0-9+/=]+$/.test(line) && line.length > 40)
      .map(line => Buffer.from(line, 'base64').toString('utf8'))
      .join('');
    expect(html).toContain('<div dir="ltr">');

    // A0.2 regression guard: RFC 5322 caps a line at 998 octets.
    for (const line of raw.split('\r\n')) {
      expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(998);
    }
  });
});

describe('B10.3 — a reply carries Gmail\'s quote block', () => {
  it('emits the byte-exact blockquote style and a narrow-no-break-space attribution', async () => {
    const { buildQuoteBlock } = await import('./mime.js');

    const quote = buildQuoteBlock({
      from: 'Cathy Mason <cathy@theappraisalhub.com>',
      date: '2026-08-21T11:27:00.000Z',
      html: '<div dir="ltr">Original body</div>',
      text: 'Original body',
      timeZone: 'America/New_York',
    });

    const raw = decodeRaw(
      buildRawMessage({
        from: 'Steve <steve@appraisalhost.com>',
        to: 'cathy@theappraisalhub.com',
        subject: 'Re: Gate 3',
        body: 'On it.',
        html_suffix: quote.html,
        text_suffix: quote.text,
        in_reply_to: '<abc@mail.gmail.com>',
        references: '<abc@mail.gmail.com>',
      }),
    );

    const html = raw
      .split(/\r\n/)
      .filter(line => /^[A-Za-z0-9+/=]+$/.test(line) && line.length > 40)
      .map(line => Buffer.from(line, 'base64').toString('utf8'))
      .join('');

    expect(html).toContain(
      '<blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;'
      + 'border-left:1px solid rgb(204,204,204);padding-left:1ex">',
    );
    expect(html).toContain('class="gmail_attr">On Fri, Aug 21, 2026 at 7:27\u202FAM');
    expect(html).toContain('wrote:<br>');
  });
});

describe('B10.4 — the From header carries the account display name', () => {
  it('renders "Steve <steve@appraisalhost.com>" from a sendAs profile', async () => {
    const { formatFromHeader } = await import('./mime.js');

    const from = formatFromHeader('Steve', 'steve@appraisalhost.com');
    expect(from).toBe('Steve <steve@appraisalhost.com>');

    const raw = decodeRaw(
      buildRawMessage({ from, to: 'x@example.com', subject: 'Gate 4', body: 'Hi' }),
    );
    expect(raw).toContain('From: Steve <steve@appraisalhost.com>');
  });
});

describe('B10 security gate — CRLF header injection', () => {
  it('does not let a poisoned "to" value inject a Bcc header', () => {
    const raw = decodeRaw(
      buildRawMessage({
        from: 'steve@appraisalhost.com',
        to: 'a@b.com\r\nBcc: evil@x.com',
        subject: 'Gate 5',
        body: 'Hi',
      }),
    );

    expect(raw).not.toMatch(/^Bcc:/m);

    const headerBlock = raw.split('\r\n\r\n')[0];
    expect(headerBlock.split('\r\n').filter(l => /^Bcc:/i.test(l))).toHaveLength(0);

    // The injected text is neutralized by staying inside the To value: no new
    // header line is minted, and the header set is exactly what was asked for.
    expect(headerBlock.split('\r\n').filter(l => /^[A-Za-z-]+:/.test(l)).map(l => l.split(':')[0]))
      .toEqual(['From', 'To', 'Subject', 'MIME-Version', 'Content-Type']);
    expect(headerBlock).toContain('To: a@b.com Bcc: evil@x.com');
  });

  it('does not let a poisoned subject inject headers', () => {
    const raw = decodeRaw(
      buildRawMessage({
        from: 'steve@appraisalhost.com',
        to: 'a@b.com',
        subject: 'Hello\r\nBcc: evil@x.com',
        body: 'Hi',
      }),
    );
    const headerBlock = raw.split('\r\n\r\n')[0];
    expect(headerBlock.split('\r\n').filter(l => /^Bcc:/i.test(l))).toHaveLength(0);
  });
});
