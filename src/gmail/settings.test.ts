import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { gmail_v1 } from 'googleapis';
import type { AccountConfig } from '../config.js';
import { clearSendAsCache, getSendAsProfile } from './settings.js';

const account: AccountConfig = { email: 'steve@appraisalhost.com', alias: 'steve-ah' };

function stubGmail(list: ReturnType<typeof vi.fn>): gmail_v1.Gmail {
  return { users: { settings: { sendAs: { list } } } } as unknown as gmail_v1.Gmail;
}

function ok(sendAs: gmail_v1.Schema$SendAs[]) {
  return vi.fn().mockResolvedValue({ data: { sendAs } });
}

beforeEach(() => {
  clearSendAsCache();
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
  clearSendAsCache();
});

describe('getSendAsProfile', () => {
  it('parses the isDefault entry', async () => {
    const list = ok([
      { sendAsEmail: 'other@x.com', displayName: 'Other', isDefault: false },
      {
        sendAsEmail: 'steve@appraisalhost.com',
        displayName: 'Steve',
        signature: '<div dir="ltr">Thank You,<br>Steve Angelo</div>',
        replyToAddress: 'reply@appraisalhost.com',
        isDefault: true,
      },
    ]);
    await expect(getSendAsProfile(account, stubGmail(list))).resolves.toEqual({
      email: 'steve@appraisalhost.com',
      displayName: 'Steve',
      signatureHtml: '<div dir="ltr">Thank You,<br>Steve Angelo</div>',
      replyTo: 'reply@appraisalhost.com',
    });
  });

  it('falls back to isPrimary when nothing is marked default', async () => {
    const list = ok([
      { sendAsEmail: 'alias@x.com', displayName: 'Alias' },
      { sendAsEmail: 'steve@appraisalhost.com', displayName: 'Steve', isPrimary: true },
    ]);
    const profile = await getSendAsProfile(account, stubGmail(list));
    expect(profile.displayName).toBe('Steve');
  });

  it('falls back to the entry matching the account email, case-insensitively', async () => {
    const list = ok([
      { sendAsEmail: 'alias@x.com', displayName: 'Alias' },
      { sendAsEmail: 'STEVE@APPRAISALHOST.COM', displayName: 'Steve' },
    ]);
    const profile = await getSendAsProfile(account, stubGmail(list));
    expect(profile.displayName).toBe('Steve');
  });

  it('caches within the TTL — two calls make one API call', async () => {
    const list = ok([{ sendAsEmail: account.email, displayName: 'Steve', isDefault: true }]);
    const gmail = stubGmail(list);
    await getSendAsProfile(account, gmail);
    await getSendAsProfile(account, gmail);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('refetches after the TTL expires', async () => {
    vi.useFakeTimers();
    const list = ok([{ sendAsEmail: account.email, displayName: 'Steve', isDefault: true }]);
    const gmail = stubGmail(list);
    await getSendAsProfile(account, gmail);
    vi.advanceTimersByTime(51 * 60 * 1000);
    await getSendAsProfile(account, gmail);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('returns an empty profile on a 403 and does not throw', async () => {
    const err = new Error('insufficient scope') as Error & { code?: number };
    err.code = 403;
    const list = vi.fn().mockRejectedValue(err);
    await expect(getSendAsProfile(account, stubGmail(list))).resolves.toEqual({
      email: account.email,
      displayName: '',
      signatureHtml: '',
      replyTo: '',
    });
  });

  it('does not cache a FAILED lookup for the full success TTL', async () => {
    // A single network blip used to strip the display name and the signature
    // from every message sent for the next 50 minutes, silently.
    vi.useFakeTimers();
    const list = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient 503'))
      .mockResolvedValue({
        data: { sendAs: [{ sendAsEmail: account.email, displayName: 'Steve', isDefault: true }] },
      });
    const gmail = stubGmail(list);

    expect((await getSendAsProfile(account, gmail)).displayName).toBe('');
    vi.advanceTimersByTime(2 * 60 * 1000);
    expect((await getSendAsProfile(account, gmail)).displayName).toBe('Steve');
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('still caches a failure briefly so a hard outage does not retry every send', async () => {
    vi.useFakeTimers();
    const list = vi.fn().mockRejectedValue(new Error('down'));
    const gmail = stubGmail(list);
    await getSendAsProfile(account, gmail);
    vi.advanceTimersByTime(5 * 1000);
    await getSendAsProfile(account, gmail);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('returns an empty profile when the account has no sendAs entries', async () => {
    const profile = await getSendAsProfile(account, stubGmail(ok([])));
    expect(profile).toEqual({
      email: account.email,
      displayName: '',
      signatureHtml: '',
      replyTo: '',
    });
  });

  it('yields an empty signature when the account has none set', async () => {
    const list = ok([{ sendAsEmail: account.email, isDefault: true, signature: '' }]);
    const profile = await getSendAsProfile(account, stubGmail(list));
    expect(profile.signatureHtml).toBe('');
  });
});
