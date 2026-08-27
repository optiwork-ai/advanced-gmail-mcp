/**
 * Tests for the mail-rule and vacation-responder layer, against a stubbed
 * `gmail_v1` settings surface. `googleapis`, the OAuth client, the account
 * config and the logger are all mocked: no network, no token files, no real
 * account. No filter is ever created and the vacation responder is never
 * actually switched on anywhere.
 *
 * Stubs are the ONLY coverage available for this module. It needs
 * `gmail.settings.basic`, a scope added on 2026-08-27, and no stored token
 * carries it until every alias re-consents — so a live probe of these paths
 * could not succeed even if a builder were allowed to make one. The
 * missing-scope tests below pin the behaviour every account gets TODAY.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = {
  users: {
    settings: {
      filters: { list: vi.fn(), create: vi.fn(), delete: vi.fn() },
      getVacation: vi.fn(),
      updateVacation: vi.fn(),
    },
  },
};

vi.mock('googleapis', () => ({
  google: { gmail: () => api },
}));

vi.mock('./auth.js', () => ({
  getAuthClient: vi.fn(async () => ({})),
}));

vi.mock('../config.js', () => ({
  resolveAccount: (input?: string) => ({
    alias: input ?? 'test',
    email: input?.includes('@') ? input : 'me@example.com',
  }),
}));

const logCalls: { level: string; message: string; fields: Record<string, unknown> }[] = [];
vi.mock('../log.js', () => ({
  log: (level: string, message: string, fields: Record<string, unknown> = {}) => {
    logCalls.push({ level, message, fields });
  },
}));

const {
  GMAIL_SETTINGS_SCOPE,
  createFilter,
  deleteFilter,
  getVacation,
  listFilters,
  setVacation,
} = await import('./settings-api.js');

const f = api.users.settings.filters;
const v = api.users.settings;

beforeEach(() => {
  f.list.mockReset();
  f.create.mockReset();
  f.delete.mockReset();
  v.getVacation.mockReset();
  v.updateVacation.mockReset();
  logCalls.length = 0;
});

// ---------------------------------------------------------------------------
// list_filters
// ---------------------------------------------------------------------------

describe('listFilters', () => {
  it('maps criteria and label actions, defaulting the action lists to empty', async () => {
    f.list.mockResolvedValueOnce({
      data: {
        filter: [
          {
            id: 'f1',
            criteria: { from: 'news@example.com', hasAttachment: true },
            action: { addLabelIds: ['Label_1'], removeLabelIds: ['INBOX'] },
          },
          { id: 'f2', criteria: { subject: 'invoice' }, action: {} },
        ],
      },
    });

    const result = await listFilters('work');

    expect(result.account).toBe('work');
    expect(result.filters[0]).toEqual({
      id: 'f1',
      criteria: { from: 'news@example.com', hasAttachment: true },
      addLabelIds: ['Label_1'],
      removeLabelIds: ['INBOX'],
    });
    expect(result.filters[1].addLabelIds).toEqual([]);
    expect(result.filters[1].removeLabelIds).toEqual([]);
  });

  it('reports an EXISTING forwarding filter even though this server cannot create one', async () => {
    f.list.mockResolvedValueOnce({
      data: { filter: [{ id: 'f9', criteria: { from: 'a@b.com' }, action: { forward: 'else@where.com' } }] },
    });

    const result = await listFilters();

    expect(result.filters[0].forward).toBe('else@where.com');
  });

  it('returns an empty list when the account has no filters', async () => {
    f.list.mockResolvedValueOnce({ data: {} });
    expect((await listFilters()).filters).toEqual([]);
  });

  it('does not log — it is read-only', async () => {
    f.list.mockResolvedValueOnce({ data: { filter: [] } });
    await listFilters();
    expect(logCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// create_filter
// ---------------------------------------------------------------------------

describe('createFilter', () => {
  it('sends the trimmed criteria and label actions', async () => {
    f.create.mockResolvedValueOnce({
      data: { id: 'new-1', criteria: { from: 'news@example.com' }, action: { addLabelIds: ['Label_1'] } },
    });

    const result = await createFilter({
      criteria: { from: '  news@example.com  ', query: '   ' },
      addLabelIds: ['Label_1', 'Label_1', ' '],
      account: 'work',
    });

    const args = f.create.mock.calls[0][0];
    expect(args.requestBody.criteria).toEqual({ from: 'news@example.com' });
    expect(args.requestBody.action).toEqual({ addLabelIds: ['Label_1'] });
    expect(args.requestBody.action.removeLabelIds).toBeUndefined();
    expect(result.id).toBe('new-1');
    expect(result.account).toBe('work');
  });

  it('refuses a filter with no criteria, before any API call', async () => {
    await expect(createFilter({ criteria: {}, addLabelIds: ['Label_1'] }))
      .rejects.toThrow(/at least one criterion/);
    expect(f.create).not.toHaveBeenCalled();
  });

  it('refuses a filter whose criteria are all blank strings', async () => {
    await expect(createFilter({ criteria: { from: '   ', subject: '' }, addLabelIds: ['Label_1'] }))
      .rejects.toThrow(/at least one criterion/);
    expect(f.create).not.toHaveBeenCalled();
  });

  it('refuses a filter with no action, before any API call', async () => {
    await expect(createFilter({ criteria: { from: 'a@b.com' } }))
      .rejects.toThrow(/at least one of add_label_ids or remove_label_ids/);
    expect(f.create).not.toHaveBeenCalled();
  });

  it('accepts a remove-only action (that is how a filter archives)', async () => {
    f.create.mockResolvedValueOnce({
      data: { id: 'new-2', criteria: { from: 'a@b.com' }, action: { removeLabelIds: ['INBOX'] } },
    });

    await createFilter({ criteria: { from: 'a@b.com' }, removeLabelIds: ['INBOX'] });

    expect(f.create.mock.calls[0][0].requestBody.action).toEqual({ removeLabelIds: ['INBOX'] });
  });

  it('never sends a forwarding action, even if one is smuggled into the options', async () => {
    f.create.mockResolvedValueOnce({
      data: { id: 'new-3', criteria: { from: 'a@b.com' }, action: { addLabelIds: ['Label_1'] } },
    });

    await createFilter({
      criteria: { from: 'a@b.com' },
      addLabelIds: ['Label_1'],
      // A caller cannot reach this field through the tool params; assert the
      // client layer does not pass one through either.
      ...({ forward: 'attacker@evil.com' } as Record<string, unknown>),
    });

    const body = JSON.stringify(f.create.mock.calls[0][0].requestBody);
    expect(body).not.toContain('forward');
    expect(body).not.toContain('attacker@evil.com');
  });

  it('logs the creation with ids and counts, never the criteria values', async () => {
    f.create.mockResolvedValueOnce({
      data: { id: 'new-4', criteria: { from: 'secret@example.com' }, action: { addLabelIds: ['Label_1'] } },
    });

    await createFilter({ criteria: { from: 'secret@example.com' }, addLabelIds: ['Label_1'], account: 'work' });

    const entry = logCalls.find(c => c.message === 'create_filter');
    expect(entry?.fields).toMatchObject({
      account: 'work',
      filter_id: 'new-4',
      criteria_fields: ['from'],
      add_label_count: 1,
      remove_label_count: 0,
    });
    expect(JSON.stringify(entry?.fields)).not.toContain('secret@example.com');
  });
});

// ---------------------------------------------------------------------------
// delete_filter
// ---------------------------------------------------------------------------

describe('deleteFilter', () => {
  it('deletes by id and logs it', async () => {
    f.delete.mockResolvedValueOnce({ data: {} });

    const result = await deleteFilter(' f1 ', 'work');

    expect(f.delete.mock.calls[0][0]).toMatchObject({ userId: 'me', id: 'f1' });
    expect(result).toEqual({ id: 'f1', account: 'work' });
    expect(logCalls.find(c => c.message === 'delete_filter')?.fields)
      .toMatchObject({ account: 'work', filter_id: 'f1' });
  });

  it('refuses an empty id without calling the API', async () => {
    await expect(deleteFilter('   ')).rejects.toThrow(/filter_id is required/);
    expect(f.delete).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// get_vacation
// ---------------------------------------------------------------------------

describe('getVacation', () => {
  it('normalizes the settings, converting the epoch-ms window to ISO', async () => {
    v.getVacation.mockResolvedValueOnce({
      data: {
        enableAutoReply: true,
        responseSubject: 'Away',
        responseBodyPlainText: 'Back Monday',
        restrictToContacts: true,
        startTime: '1756684800000',
        endTime: '1757289600000',
      },
    });

    const state = await getVacation('work');

    expect(state.enabled).toBe(true);
    expect(state.responseSubject).toBe('Away');
    expect(state.responseBodyHtml).toBe('');
    expect(state.restrictToContacts).toBe(true);
    expect(state.restrictToDomain).toBe(false);
    expect(state.startTime).toBe(new Date(1756684800000).toISOString());
    expect(state.endTime).toBe(new Date(1757289600000).toISOString());
    expect(state.account).toBe('work');
  });

  it('reports a disabled responder with empty strings rather than undefined', async () => {
    v.getVacation.mockResolvedValueOnce({ data: { enableAutoReply: false } });

    const state = await getVacation();

    expect(state).toMatchObject({
      enabled: false,
      responseSubject: '',
      responseBodyPlainText: '',
      responseBodyHtml: '',
    });
    expect(state.startTime).toBeUndefined();
    expect(state.endTime).toBeUndefined();
  });

  it('does not log — it is read-only', async () => {
    v.getVacation.mockResolvedValueOnce({ data: {} });
    await getVacation();
    expect(logCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// set_vacation
// ---------------------------------------------------------------------------

describe('setVacation', () => {
  it('merges over the saved settings instead of replacing them', async () => {
    v.getVacation.mockResolvedValueOnce({
      data: {
        enableAutoReply: false,
        responseSubject: 'Away',
        responseBodyPlainText: 'Back Monday',
        restrictToContacts: true,
      },
    });
    v.updateVacation.mockResolvedValueOnce({
      data: { enableAutoReply: true, responseSubject: 'Away', responseBodyPlainText: 'Back Monday', restrictToContacts: true },
    });

    const result = await setVacation({ enable: true });

    const body = v.updateVacation.mock.calls[0][0].requestBody;
    expect(body).toMatchObject({
      enableAutoReply: true,
      responseSubject: 'Away',
      responseBodyPlainText: 'Back Monday',
      restrictToContacts: true,
    });
    expect(result.notice).toContain('ON');
    expect(result.notice).toContain('contacts only');
  });

  it('turning it OFF keeps the saved subject and message', async () => {
    v.getVacation.mockResolvedValueOnce({
      data: { enableAutoReply: true, responseSubject: 'Away', responseBodyPlainText: 'Back Monday' },
    });
    v.updateVacation.mockResolvedValueOnce({
      data: { enableAutoReply: false, responseSubject: 'Away', responseBodyPlainText: 'Back Monday' },
    });

    const result = await setVacation({ enable: false });

    const body = v.updateVacation.mock.calls[0][0].requestBody;
    expect(body.enableAutoReply).toBe(false);
    expect(body.responseSubject).toBe('Away');
    expect(body.responseBodyPlainText).toBe('Back Monday');
    expect(result.notice).toContain('OFF');
  });

  it('writes the supplied body to its own flavour AND derives the other one', async () => {
    v.getVacation.mockResolvedValue({ data: {} });
    v.updateVacation.mockResolvedValue({ data: { enableAutoReply: true } });

    await setVacation({ enable: true, body: '<p>Away</p>', isHtml: true });
    const html = v.updateVacation.mock.calls[0][0].requestBody;
    expect(html.responseBodyHtml).toBe('<p>Away</p>');
    expect(html.responseBodyPlainText).toBe('Away');

    await setVacation({ enable: true, body: 'Away' });
    const plain = v.updateVacation.mock.calls[1][0].requestBody;
    expect(plain.responseBodyPlainText).toBe('Away');
    expect(plain.responseBodyHtml).toContain('Away');
  });

  // R2-C1: Gmail prefers responseBodyHtml when both are set. Writing only the
  // flavour the caller supplied left the OTHER one saying something else, so a
  // plain-text change to an HTML responder reported success and changed nothing
  // about what the account actually replies.
  it('a plain body REPLACES a saved HTML responder rather than leaving it stale', async () => {
    v.getVacation.mockResolvedValueOnce({
      data: {
        enableAutoReply: true,
        responseBodyHtml: '<p>OLD html reply - I am in Spain until March</p>',
      },
    });
    v.updateVacation.mockResolvedValueOnce({ data: { enableAutoReply: true } });

    await setVacation({ enable: true, body: 'NEW plain reply - back tomorrow' });

    const body = v.updateVacation.mock.calls[0][0].requestBody;
    expect(body.responseBodyPlainText).toBe('NEW plain reply - back tomorrow');
    expect(body.responseBodyHtml).toContain('NEW plain reply');
    expect(body.responseBodyHtml).not.toContain('Spain');
  });

  it('an HTML body REPLACES a saved plain-text responder rather than leaving it stale', async () => {
    v.getVacation.mockResolvedValueOnce({
      data: { enableAutoReply: true, responseBodyPlainText: 'OLD plain reply' },
    });
    v.updateVacation.mockResolvedValueOnce({ data: { enableAutoReply: true } });

    await setVacation({ enable: true, body: '<p>NEW html reply</p>', isHtml: true });

    const body = v.updateVacation.mock.calls[0][0].requestBody;
    expect(body.responseBodyHtml).toBe('<p>NEW html reply</p>');
    expect(body.responseBodyPlainText).toBe('NEW html reply');
    expect(body.responseBodyPlainText).not.toContain('OLD');
  });

  it('leaves BOTH saved flavours alone when no body is supplied', async () => {
    v.getVacation.mockResolvedValueOnce({
      data: {
        enableAutoReply: false,
        responseBodyHtml: '<p>Saved html</p>',
        responseBodyPlainText: 'Saved text',
      },
    });
    v.updateVacation.mockResolvedValueOnce({ data: { enableAutoReply: true } });

    await setVacation({ enable: true });

    const body = v.updateVacation.mock.calls[0][0].requestBody;
    expect(body.responseBodyHtml).toBe('<p>Saved html</p>');
    expect(body.responseBodyPlainText).toBe('Saved text');
  });

  it('converts an ISO window to the epoch-ms strings Gmail wants', async () => {
    v.getVacation.mockResolvedValueOnce({ data: {} });
    v.updateVacation.mockResolvedValueOnce({ data: { enableAutoReply: true } });

    await setVacation({
      enable: true,
      body: 'Away',
      startTime: '2026-09-01T00:00:00.000Z',
      endTime: '2026-09-08T00:00:00.000Z',
    });

    const body = v.updateVacation.mock.calls[0][0].requestBody;
    expect(body.startTime).toBe(String(Date.parse('2026-09-01T00:00:00.000Z')));
    expect(body.endTime).toBe(String(Date.parse('2026-09-08T00:00:00.000Z')));
  });

  it('refuses to enable with no body anywhere — nothing saved, nothing supplied', async () => {
    v.getVacation.mockResolvedValueOnce({ data: { enableAutoReply: false } });

    await expect(setVacation({ enable: true })).rejects.toThrow(/response body is required/);
    expect(v.updateVacation).not.toHaveBeenCalled();
  });

  it('refuses an unparseable start_time before writing anything', async () => {
    v.getVacation.mockResolvedValueOnce({ data: { responseBodyPlainText: 'Away' } });

    await expect(setVacation({ enable: true, startTime: 'next tuesday' }))
      .rejects.toThrow(/not a valid ISO 8601/);
    expect(v.updateVacation).not.toHaveBeenCalled();
  });

  it('refuses an inverted window', async () => {
    v.getVacation.mockResolvedValueOnce({ data: { responseBodyPlainText: 'Away' } });

    await expect(setVacation({
      enable: true,
      startTime: '2026-09-08T00:00:00.000Z',
      endTime: '2026-09-01T00:00:00.000Z',
    })).rejects.toThrow(/must be after/);
    expect(v.updateVacation).not.toHaveBeenCalled();
  });

  it('logs the switch with flags only, never the auto-reply text', async () => {
    v.getVacation.mockResolvedValueOnce({ data: {} });
    v.updateVacation.mockResolvedValueOnce({ data: { enableAutoReply: true } });

    await setVacation({ enable: true, body: 'I am at a funeral', account: 'work' });

    const entry = logCalls.find(c => c.message === 'set_vacation');
    expect(entry?.fields).toMatchObject({ account: 'work', enable: true });
    expect(JSON.stringify(entry?.fields)).not.toContain('funeral');
  });
});

// ---------------------------------------------------------------------------
// The missing-scope path — the state EVERY account is in until it re-consents
// ---------------------------------------------------------------------------

describe('without the gmail.settings.basic grant', () => {
  const insufficient = () =>
    Object.assign(new Error('Request had insufficient authentication scopes.'), { code: 403 });

  it('list_filters explains the missing scope and names the alias', async () => {
    f.list.mockRejectedValue(insufficient());
    await expect(listFilters('steve-ah')).rejects.toThrow(/list_filters needs the .* scope/);
    await expect(listFilters('steve-ah')).rejects.toThrow(/npm run auth -- steve-ah/);
  });

  it('create_filter explains the missing scope', async () => {
    f.create.mockRejectedValue(insufficient());
    await expect(createFilter({ criteria: { from: 'a@b.com' }, addLabelIds: ['L'] }))
      .rejects.toThrow(GMAIL_SETTINGS_SCOPE);
  });

  it('delete_filter explains the missing scope', async () => {
    f.delete.mockRejectedValue(insufficient());
    await expect(deleteFilter('f1')).rejects.toThrow(/delete_filter needs the/);
  });

  it('get_vacation explains the missing scope', async () => {
    v.getVacation.mockRejectedValue(insufficient());
    await expect(getVacation()).rejects.toThrow(/get_vacation needs the/);
  });

  it('set_vacation fails on the READ half, before it can change anything', async () => {
    v.getVacation.mockRejectedValue(insufficient());
    await expect(setVacation({ enable: true, body: 'Away' })).rejects.toThrow(/set_vacation needs the/);
    expect(v.updateVacation).not.toHaveBeenCalled();
  });

  it('recognizes the rewritten message withRetry produces for a 403', async () => {
    f.list.mockRejectedValue(new Error('Authentication error (403): Insufficient Permission'));
    await expect(listFilters('steve-ah')).rejects.toThrow(/needs the .* scope/);
  });

  it('leaves a non-auth failure alone', async () => {
    f.delete.mockRejectedValue(Object.assign(new Error('Filter not found'), { code: 404 }));
    await expect(deleteFilter('nope')).rejects.toThrow(/Filter not found/);
  });
});
