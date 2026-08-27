/**
 * Tests for the Calendar API layer — exercised against a stubbed
 * `calendar_v3.Calendar`. `googleapis`, the OAuth client and the account
 * config are all mocked, so nothing here touches the network, the token
 * files or the real accounts.json. No event is ever created for real.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// --- stub the Calendar API surface ----------------------------------------

const api = {
  calendarList: { list: vi.fn() },
  events: { list: vi.fn(), insert: vi.fn() },
  freebusy: { query: vi.fn() },
};

vi.mock('googleapis', () => ({
  google: { calendar: () => api },
}));

vi.mock('../gmail/auth.js', () => ({
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
  DEFAULT_EVENT_PAGE_SIZE,
  MAX_EVENT_PAGE_SIZE,
  buildEventDateTime,
  createEvent,
  getCalendarClient,
  listCalendars,
  listEvents,
  queryFreeBusy,
} = await import('./client.js');

beforeEach(() => {
  for (const group of Object.values(api)) {
    for (const fn of Object.values(group)) (fn as ReturnType<typeof vi.fn>).mockReset();
  }
  logCalls.length = 0;
});

// ---------------------------------------------------------------------------
// client factory
// ---------------------------------------------------------------------------

describe('getCalendarClient', () => {
  it('returns the same cached client for repeat calls on one account', async () => {
    const a = await getCalendarClient('cache-probe@example.com');
    const b = await getCalendarClient('cache-probe@example.com');
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// listCalendars
// ---------------------------------------------------------------------------

describe('listCalendars', () => {
  it('maps the calendarList entries and marks the primary', async () => {
    api.calendarList.list.mockResolvedValueOnce({
      data: {
        items: [
          { id: 'me@example.com', summary: 'Me', primary: true, accessRole: 'owner', timeZone: 'America/New_York', selected: true },
          { id: 'team@example.com', summary: 'Team', accessRole: 'reader' },
        ],
      },
    });

    const calendars = await listCalendars('steve');

    expect(calendars).toEqual([
      { id: 'me@example.com', summary: 'Me', timeZone: 'America/New_York', accessRole: 'owner', primary: true, selected: true },
      { id: 'team@example.com', summary: 'Team', accessRole: 'reader' },
    ]);
  });

  it('paginates until nextPageToken runs out', async () => {
    api.calendarList.list
      .mockResolvedValueOnce({ data: { items: [{ id: 'a', summary: 'A' }], nextPageToken: 'p2' } })
      .mockResolvedValueOnce({ data: { items: [{ id: 'b', summary: 'B' }] } });

    const calendars = await listCalendars();

    expect(calendars.map(c => c.id)).toEqual(['a', 'b']);
    expect(api.calendarList.list).toHaveBeenCalledTimes(2);
    expect(api.calendarList.list.mock.calls[1][0].pageToken).toBe('p2');
  });

  it('skips entries with no id rather than emitting an empty one', async () => {
    api.calendarList.list.mockResolvedValueOnce({
      data: { items: [{ summary: 'ghost' }, { id: 'real', summary: 'Real' }] },
    });
    const calendars = await listCalendars();
    expect(calendars.map(c => c.id)).toEqual(['real']);
  });

  it('returns an empty list when the API returns no items', async () => {
    api.calendarList.list.mockResolvedValueOnce({ data: {} });
    await expect(listCalendars()).resolves.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// listEvents
// ---------------------------------------------------------------------------

describe('listEvents', () => {
  it('defaults to the primary calendar, singleEvents and startTime order', async () => {
    api.events.list.mockResolvedValueOnce({ data: { items: [] } });

    const result = await listEvents();

    const args = api.events.list.mock.calls[0][0];
    expect(args.calendarId).toBe('primary');
    expect(args.singleEvents).toBe(true);
    expect(args.orderBy).toBe('startTime');
    expect(args.maxResults).toBe(DEFAULT_EVENT_PAGE_SIZE);
    expect(result.calendarId).toBe('primary');
  });

  it('caps max_results at the ceiling and floors it at 1', async () => {
    api.events.list.mockResolvedValue({ data: { items: [] } });

    await listEvents({ maxResults: 9999 });
    expect(api.events.list.mock.calls[0][0].maxResults).toBe(MAX_EVENT_PAGE_SIZE);

    await listEvents({ maxResults: 0 });
    expect(api.events.list.mock.calls[1][0].maxResults).toBe(1);

    await listEvents({ maxResults: -5 });
    expect(api.events.list.mock.calls[2][0].maxResults).toBe(1);
  });

  it('passes through the time window, query and page token', async () => {
    api.events.list.mockResolvedValueOnce({ data: { items: [] } });

    await listEvents({
      calendarId: 'team@example.com',
      timeMin: '2026-09-01T00:00:00Z',
      timeMax: '2026-09-30T00:00:00Z',
      query: 'standup',
      pageToken: 'tok',
    });

    expect(api.events.list.mock.calls[0][0]).toMatchObject({
      calendarId: 'team@example.com',
      timeMin: '2026-09-01T00:00:00Z',
      timeMax: '2026-09-30T00:00:00Z',
      q: 'standup',
      pageToken: 'tok',
    });
  });

  it('sends undefined rather than empty strings for the optional filters', async () => {
    api.events.list.mockResolvedValueOnce({ data: { items: [] } });
    await listEvents({ timeMin: '', query: '', pageToken: '' });
    const args = api.events.list.mock.calls[0][0];
    expect(args.timeMin).toBeUndefined();
    expect(args.q).toBeUndefined();
    expect(args.pageToken).toBeUndefined();
  });

  it('flags an all-day event and a timed event correctly', async () => {
    api.events.list.mockResolvedValueOnce({
      data: {
        items: [
          { id: 'ad', summary: 'Holiday', start: { date: '2026-09-01' }, end: { date: '2026-09-02' } },
          {
            id: 'tm',
            summary: 'Call',
            start: { dateTime: '2026-09-01T14:00:00-04:00' },
            end: { dateTime: '2026-09-01T15:00:00-04:00' },
          },
        ],
      },
    });

    const { events } = await listEvents();

    expect(events[0].allDay).toBe(true);
    expect(events[1].allDay).toBe(false);
  });

  it('summarises organizer, attendees and links, dropping attendees with no email', async () => {
    api.events.list.mockResolvedValueOnce({
      data: {
        items: [
          {
            id: 'e1',
            status: 'confirmed',
            summary: 'Sync',
            location: 'Room 2',
            description: 'agenda',
            organizer: { email: 'boss@example.com' },
            attendees: [
              { email: 'a@example.com', responseStatus: 'accepted' },
              { email: 'b@example.com', optional: true },
              { displayName: 'no address' },
            ],
            hangoutLink: 'https://meet.example/x',
            htmlLink: 'https://calendar.example/e1',
            recurringEventId: 'r1',
            start: { dateTime: '2026-09-01T14:00:00Z' },
            end: { dateTime: '2026-09-01T15:00:00Z' },
          },
        ],
      },
    });

    const { events } = await listEvents();

    expect(events[0]).toMatchObject({
      id: 'e1',
      status: 'confirmed',
      organizer: 'boss@example.com',
      hangoutLink: 'https://meet.example/x',
      recurringEventId: 'r1',
    });
    expect(events[0].attendees).toEqual([
      { email: 'a@example.com', responseStatus: 'accepted' },
      { email: 'b@example.com', optional: true },
    ]);
  });

  it('returns nextPageToken when the API gives one and omits it otherwise', async () => {
    api.events.list.mockResolvedValueOnce({ data: { items: [], nextPageToken: 'more' } });
    await expect(listEvents()).resolves.toMatchObject({ nextPageToken: 'more' });

    api.events.list.mockResolvedValueOnce({ data: { items: [] } });
    const second = await listEvents();
    expect('nextPageToken' in second).toBe(false);
  });

  it('never calls a mutating method', async () => {
    api.events.list.mockResolvedValueOnce({ data: { items: [] } });
    await listEvents();
    expect(api.events.insert).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// queryFreeBusy
// ---------------------------------------------------------------------------

describe('queryFreeBusy', () => {
  it('defaults to the primary calendar', async () => {
    api.freebusy.query.mockResolvedValueOnce({ data: { calendars: { primary: { busy: [] } } } });

    await queryFreeBusy({ timeMin: '2026-09-01T00:00:00Z', timeMax: '2026-09-02T00:00:00Z' });

    expect(api.freebusy.query.mock.calls[0][0].requestBody.items).toEqual([{ id: 'primary' }]);
  });

  it('passes every requested calendar id through', async () => {
    api.freebusy.query.mockResolvedValueOnce({ data: { calendars: {} } });

    await queryFreeBusy({
      timeMin: '2026-09-01T00:00:00Z',
      timeMax: '2026-09-02T00:00:00Z',
      calendarIds: ['a@example.com', 'b@example.com'],
    });

    expect(api.freebusy.query.mock.calls[0][0].requestBody.items).toEqual([
      { id: 'a@example.com' },
      { id: 'b@example.com' },
    ]);
  });

  it('falls back to primary when an empty id array is passed', async () => {
    api.freebusy.query.mockResolvedValueOnce({ data: { calendars: {} } });
    await queryFreeBusy({ timeMin: 'a', timeMax: 'b', calendarIds: [] });
    expect(api.freebusy.query.mock.calls[0][0].requestBody.items).toEqual([{ id: 'primary' }]);
  });

  it('reports busy windows per calendar', async () => {
    api.freebusy.query.mockResolvedValueOnce({
      data: {
        timeMin: '2026-09-01T00:00:00Z',
        timeMax: '2026-09-02T00:00:00Z',
        calendars: {
          primary: { busy: [{ start: '2026-09-01T14:00:00Z', end: '2026-09-01T15:00:00Z' }] },
        },
      },
    });

    const result = await queryFreeBusy({ timeMin: '2026-09-01T00:00:00Z', timeMax: '2026-09-02T00:00:00Z' });

    expect(result.calendars.primary.busy).toEqual([
      { start: '2026-09-01T14:00:00Z', end: '2026-09-01T15:00:00Z' },
    ]);
  });

  it('surfaces a per-calendar error without losing the readable calendars', async () => {
    api.freebusy.query.mockResolvedValueOnce({
      data: {
        calendars: {
          primary: { busy: [{ start: 's', end: 'e' }] },
          'locked@example.com': { busy: [], errors: [{ domain: 'global', reason: 'notFound' }] },
        },
      },
    });

    const result = await queryFreeBusy({ timeMin: 'a', timeMax: 'b', calendarIds: ['primary', 'locked@example.com'] });

    expect(result.calendars.primary.busy).toHaveLength(1);
    expect(result.calendars['locked@example.com'].errors).toEqual([
      { domain: 'global', reason: 'notFound' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// buildEventDateTime
// ---------------------------------------------------------------------------

describe('buildEventDateTime', () => {
  it('uses `date` for an all-day event', () => {
    expect(buildEventDateTime('2026-09-01', true, undefined, 'start')).toEqual({ date: '2026-09-01' });
  });

  it('rejects a timestamp when all_day is set', () => {
    expect(() => buildEventDateTime('2026-09-01T14:00:00Z', true, undefined, 'start')).toThrow(/YYYY-MM-DD/);
  });

  it('uses `dateTime` and carries the time zone for a timed event', () => {
    expect(buildEventDateTime('2026-09-01T14:00:00-04:00', false, 'America/New_York', 'end')).toEqual({
      dateTime: '2026-09-01T14:00:00-04:00',
      timeZone: 'America/New_York',
    });
  });

  it('omits timeZone when none was given', () => {
    expect(buildEventDateTime('2026-09-01T14:00:00Z', false, undefined, 'start')).toEqual({
      dateTime: '2026-09-01T14:00:00Z',
    });
  });

  it('refuses a date-only value for a timed event instead of guessing midnight', () => {
    expect(() => buildEventDateTime('2026-09-01', false, undefined, 'start')).toThrow(/all_day/);
  });

  it('refuses an unparseable timestamp', () => {
    expect(() => buildEventDateTime('next tuesday', false, undefined, 'end')).toThrow(/not a valid ISO 8601/);
  });

  it('refuses an empty value', () => {
    expect(() => buildEventDateTime('   ', false, undefined, 'start')).toThrow(/required/);
  });
});

// ---------------------------------------------------------------------------
// createEvent — the one mutating path
// ---------------------------------------------------------------------------

describe('createEvent', () => {
  const ok = {
    data: {
      id: 'evt1',
      status: 'confirmed',
      summary: 'Test',
      htmlLink: 'https://calendar.example/evt1',
      start: { dateTime: '2026-09-01T14:00:00Z' },
      end: { dateTime: '2026-09-01T15:00:00Z' },
    },
  };

  it("defaults send_updates to 'none' so nobody is emailed", async () => {
    api.events.insert.mockResolvedValueOnce(ok);

    const result = await createEvent({
      summary: 'Test',
      start: '2026-09-01T14:00:00Z',
      end: '2026-09-01T15:00:00Z',
      attendees: ['a@example.com'],
    });

    expect(api.events.insert.mock.calls[0][0].sendUpdates).toBe('none');
    expect(result.sendUpdates).toBe('none');
    expect(result.notice).toMatch(/No invitation emails were sent/);
  });

  it('refuses an end that is before the start, like get_freebusy does', async () => {
    await expect(
      createEvent({
        summary: 'Test',
        start: '2026-09-01T15:00:00Z',
        end: '2026-09-01T14:00:00Z',
      }),
    ).rejects.toThrow(/end .* must be after start/i);
    expect(api.events.insert).not.toHaveBeenCalled();
  });

  it('refuses a zero-length timed event', async () => {
    await expect(
      createEvent({
        summary: 'Test',
        start: '2026-09-01T14:00:00Z',
        end: '2026-09-01T14:00:00Z',
      }),
    ).rejects.toThrow(/must be after/i);
    expect(api.events.insert).not.toHaveBeenCalled();
  });

  it('refuses an inverted all-day range', async () => {
    await expect(
      createEvent({
        summary: 'Test',
        start: '2026-09-03',
        end: '2026-09-01',
        allDay: true,
      }),
    ).rejects.toThrow(/before/i);
    expect(api.events.insert).not.toHaveBeenCalled();
  });

  it('allows a single-day all-day event where end equals start', async () => {
    api.events.insert.mockResolvedValueOnce({ data: { id: 'evt2' } });
    await expect(
      createEvent({ summary: 'Test', start: '2026-09-01', end: '2026-09-01', allDay: true }),
    ).resolves.toMatchObject({ id: 'evt2' });
  });

  it("passes 'all' through and says plainly that Google emailed the attendees", async () => {
    api.events.insert.mockResolvedValueOnce(ok);

    const result = await createEvent({
      summary: 'Test',
      start: '2026-09-01T14:00:00Z',
      end: '2026-09-01T15:00:00Z',
      attendees: ['a@example.com'],
      sendUpdates: 'all',
    });

    expect(api.events.insert.mock.calls[0][0].sendUpdates).toBe('all');
    expect(result.notice).toMatch(/emailed invitations/);
  });

  it('defaults to the primary calendar and maps attendees to the API shape', async () => {
    api.events.insert.mockResolvedValueOnce(ok);

    await createEvent({
      summary: 'Test',
      start: '2026-09-01T14:00:00Z',
      end: '2026-09-01T15:00:00Z',
      attendees: [' a@example.com ', '', 'b@example.com'],
    });

    const args = api.events.insert.mock.calls[0][0];
    expect(args.calendarId).toBe('primary');
    expect(args.requestBody.attendees).toEqual([
      { email: 'a@example.com' },
      { email: 'b@example.com' },
    ]);
  });

  it('omits the attendees key entirely when none were given', async () => {
    api.events.insert.mockResolvedValueOnce(ok);
    await createEvent({ summary: 'Solo', start: '2026-09-01T14:00:00Z', end: '2026-09-01T15:00:00Z' });
    expect('attendees' in api.events.insert.mock.calls[0][0].requestBody).toBe(false);
  });

  it('builds an all-day event from date-only start/end', async () => {
    api.events.insert.mockResolvedValueOnce({ data: { id: 'evt2' } });

    await createEvent({ summary: 'Holiday', start: '2026-09-01', end: '2026-09-02', allDay: true });

    const body = api.events.insert.mock.calls[0][0].requestBody;
    expect(body.start).toEqual({ date: '2026-09-01' });
    expect(body.end).toEqual({ date: '2026-09-02' });
  });

  it('refuses an empty summary before calling the API', async () => {
    await expect(
      createEvent({ summary: '  ', start: '2026-09-01T14:00:00Z', end: '2026-09-01T15:00:00Z' }),
    ).rejects.toThrow(/summary is required/);
    expect(api.events.insert).not.toHaveBeenCalled();
  });

  it('refuses a bad start before calling the API', async () => {
    await expect(
      createEvent({ summary: 'x', start: 'whenever', end: '2026-09-01T15:00:00Z' }),
    ).rejects.toThrow(/not a valid ISO 8601/);
    expect(api.events.insert).not.toHaveBeenCalled();
  });

  it('logs the creation with ids and counts only — no attendee addresses', async () => {
    api.events.insert.mockResolvedValueOnce(ok);

    await createEvent({
      summary: 'Test',
      start: '2026-09-01T14:00:00Z',
      end: '2026-09-01T15:00:00Z',
      attendees: ['secret@example.com'],
      account: 'steve-ah',
    });

    const entry = logCalls.find(c => c.message === 'create_calendar_event');
    expect(entry).toBeDefined();
    expect(entry!.fields).toEqual({
      account: 'steve-ah',
      calendar_id: 'primary',
      event_id: 'evt1',
      attendee_count: 1,
      send_updates: 'none',
    });
    expect(JSON.stringify(entry!.fields)).not.toContain('secret@example.com');
  });

  it('does not log when the insert fails', async () => {
    api.events.insert.mockRejectedValueOnce(Object.assign(new Error('boom'), { code: 400 }));

    await expect(
      createEvent({ summary: 'x', start: '2026-09-01T14:00:00Z', end: '2026-09-01T15:00:00Z' }),
    ).rejects.toThrow('boom');

    expect(logCalls.find(c => c.message === 'create_calendar_event')).toBeUndefined();
  });
});
