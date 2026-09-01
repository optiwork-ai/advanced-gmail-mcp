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
  events: { list: vi.fn(), insert: vi.fn(), get: vi.fn() },
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
  CALENDAR_LIST_SCOPE,
  DEFAULT_EVENT_PAGE_SIZE,
  MAX_EVENT_PAGE_SIZE,
  buildEventDateTime,
  createEvent,
  extractMeetLink,
  getCalendarClient,
  translateCalendarError,
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
      add_meet: false,
      meet_status: null,
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

// ---------------------------------------------------------------------------
// createEvent + Google Meet (add_meet)
//
// A conference createRequest is ASYNCHRONOUS. The insert response can come back
// `pending` with no link on it at all, and the link appears on a later read of
// the same event — so "read the link off the insert response" would hand back a
// meeting whose link is the empty string. These tests drive the pending path
// through the same mocked client the rest of the file uses, with the sleep
// injected so the poll costs no wall-clock time.
// ---------------------------------------------------------------------------

describe('createEvent with add_meet', () => {
  const LINK = 'https://meet.google.com/abc-defg-hij';

  const base = {
    summary: 'Meet test',
    start: '2026-09-01T14:00:00Z',
    end: '2026-09-01T15:00:00Z',
  };

  /** An events.insert / events.get response carrying a createRequest status. */
  function withConference(statusCode: string, extras: Record<string, unknown> = {}) {
    return {
      data: {
        id: 'evt-meet',
        status: 'confirmed',
        summary: 'Meet test',
        conferenceData: {
          createRequest: {
            requestId: 'req-1',
            conferenceSolutionKey: { type: 'hangoutsMeet' },
            status: { statusCode },
          },
        },
        ...extras,
      },
    };
  }

  /** Records what the poll WOULD have waited, and waits nothing. */
  function recordingSleep(): { waits: number[]; sleep: (ms: number) => Promise<void> } {
    const waits: number[] = [];
    return {
      waits,
      sleep: async (ms: number) => {
        waits.push(ms);
      },
    };
  }

  const plainOk = {
    data: {
      id: 'evt1',
      status: 'confirmed',
      summary: 'Meet test',
      htmlLink: 'https://calendar.example/evt1',
      start: { dateTime: '2026-09-01T14:00:00Z' },
      end: { dateTime: '2026-09-01T15:00:00Z' },
    },
  };

  // (a) the request is byte-identical to today's when no room was asked for
  it('adds nothing to the request and nothing to the result when add_meet is unset', async () => {
    api.events.insert.mockResolvedValueOnce(plainOk);

    const result = await createEvent({ ...base });

    const args = api.events.insert.mock.calls[0][0];
    expect('conferenceDataVersion' in args).toBe(false);
    expect('conferenceData' in args.requestBody).toBe(false);
    expect('meetLink' in result).toBe(false);
    expect('meetStatus' in result).toBe(false);
    expect(api.events.get).not.toHaveBeenCalled();
    expect(result.notice).toBe(
      'No invitation emails were sent (send_updates: "none"). '
      + 'Attendees see the event only if they check their calendar.',
    );
  });

  it('adds nothing to the request when add_meet is explicitly false', async () => {
    api.events.insert.mockResolvedValueOnce(plainOk);

    const result = await createEvent({ ...base, addMeet: false });

    const args = api.events.insert.mock.calls[0][0];
    expect('conferenceDataVersion' in args).toBe(false);
    expect('conferenceData' in args.requestBody).toBe(false);
    expect('meetStatus' in result).toBe(false);
  });

  // (b) the request Google actually needs to build a room
  it('asks Google for a hangoutsMeet room when add_meet is true', async () => {
    api.events.insert.mockResolvedValueOnce(withConference('success', { hangoutLink: LINK }));

    await createEvent({ ...base, addMeet: true });

    const args = api.events.insert.mock.calls[0][0];
    expect(args.conferenceDataVersion).toBe(1);
    const createRequest = args.requestBody.conferenceData.createRequest;
    expect(typeof createRequest.requestId).toBe('string');
    expect(createRequest.requestId.length).toBeGreaterThan(0);
    expect(createRequest.conferenceSolutionKey.type).toBe('hangoutsMeet');
  });

  it('gives every request its own requestId', async () => {
    api.events.insert.mockResolvedValue(withConference('success', { hangoutLink: LINK }));

    await createEvent({ ...base, addMeet: true });
    await createEvent({ ...base, addMeet: true });

    const first = api.events.insert.mock.calls[0][0].requestBody.conferenceData.createRequest.requestId;
    const second = api.events.insert.mock.calls[1][0].requestBody.conferenceData.createRequest.requestId;
    expect(first).not.toBe(second);
  });

  // (c) the happy path: the room is ready on the insert response
  it('returns the link and a success status when the room is ready straight away', async () => {
    api.events.insert.mockResolvedValueOnce(withConference('success', { hangoutLink: LINK }));

    const result = await createEvent({ ...base, addMeet: true });

    expect(result.meetLink).toBe(LINK);
    expect(result.meetStatus).toBe('success');
    expect(api.events.get).not.toHaveBeenCalled();
    expect(result.notice).toMatch(/Google Meet room is attached/);
  });

  // (d) the asynchronous path: the room arrives on a later read
  //
  // The re-read is `events.get({ calendarId, eventId })`. It deliberately does
  // NOT carry conferenceDataVersion: that parameter is not part of events.get in
  // Google's discovery document (see Params$Resource$Events$Get in googleapis)
  // and reads return conferenceData regardless. Recorded as the one literal
  // deviation from the contract's G2(d) in QUESTIONS-FOR-FABLE.md.
  it('re-reads the event until the pending room turns into a link', async () => {
    api.events.insert.mockResolvedValueOnce(withConference('pending'));
    api.events.get.mockResolvedValueOnce(withConference('pending'));
    api.events.get.mockResolvedValueOnce(withConference('success', { hangoutLink: LINK }));
    const { waits, sleep } = recordingSleep();

    const result = await createEvent({ ...base, addMeet: true, sleep });

    expect(result.meetLink).toBe(LINK);
    expect(result.meetStatus).toBe('success');
    expect(api.events.get).toHaveBeenCalledTimes(2);
    const getArgs = api.events.get.mock.calls[0][0];
    expect(getArgs.calendarId).toBe('primary');
    expect(getArgs.eventId).toBe('evt-meet');
    expect(waits).toEqual([1000, 2000]);
  });

  // (e) the room never arrives: say so, and never invent a link
  it('reports a still-pending room without fabricating a link', async () => {
    api.events.insert.mockResolvedValueOnce(withConference('pending'));
    api.events.get.mockResolvedValue(withConference('pending'));
    const { waits, sleep } = recordingSleep();

    const result = await createEvent({ ...base, addMeet: true, sleep });

    expect(result.meetStatus).toBe('pending');
    expect('meetLink' in result).toBe(false);
    expect(result.id).toBe('evt-meet');
    expect(api.events.get).toHaveBeenCalledTimes(5);
    expect(waits).toEqual([1000, 2000, 3000, 4000, 5000]);
    expect(result.notice).toMatch(/requested/i);
    expect(result.notice).toMatch(/list_calendar_events/);
  });

  // (f) Google says it cannot build one: stop, and keep the event
  it('reports a failed room, keeps the event, and does not poll', async () => {
    api.events.insert.mockResolvedValueOnce(withConference('failure'));

    const result = await createEvent({ ...base, addMeet: true });

    expect(result.meetStatus).toBe('failure');
    expect('meetLink' in result).toBe(false);
    expect(result.id).toBe('evt-meet');
    expect(api.events.get).not.toHaveBeenCalled();
    expect(result.notice).toMatch(/could not attach a Google Meet room/i);
  });

  it('stops polling the moment Google reports failure', async () => {
    api.events.insert.mockResolvedValueOnce(withConference('pending'));
    api.events.get.mockResolvedValueOnce(withConference('failure'));
    const { sleep } = recordingSleep();

    const result = await createEvent({ ...base, addMeet: true, sleep });

    expect(result.meetStatus).toBe('failure');
    expect(api.events.get).toHaveBeenCalledTimes(1);
  });

  // (g) the link is not always on hangoutLink
  it('reads the link from the video entry point when hangoutLink is absent', async () => {
    api.events.insert.mockResolvedValueOnce(
      withConference('success', {
        conferenceData: {
          createRequest: { status: { statusCode: 'success' } },
          entryPoints: [
            { entryPointType: 'phone', uri: 'tel:+1-555-0100' },
            { entryPointType: 'video', uri: LINK },
          ],
        },
      }),
    );

    const result = await createEvent({ ...base, addMeet: true });

    expect(result.meetLink).toBe(LINK);
    expect(result.meetStatus).toBe('success');
  });

  // A created event must survive a failing read-back: the event EXISTS on
  // Google's side, so turning the poll's error into a thrown createEvent would
  // report a creation that happened as a creation that did not.
  it('keeps the created event when the re-read itself fails', async () => {
    api.events.insert.mockResolvedValueOnce(withConference('pending'));
    api.events.get.mockRejectedValue(Object.assign(new Error('boom'), { code: 400 }));
    const { sleep } = recordingSleep();

    const result = await createEvent({ ...base, addMeet: true, sleep });

    expect(result.id).toBe('evt-meet');
    expect(result.meetStatus).toBe('pending');
    expect('meetLink' in result).toBe(false);
  });

  it('logs whether a room was asked for and how it ended — never the link', async () => {
    api.events.insert.mockResolvedValueOnce(withConference('success', { hangoutLink: LINK }));

    await createEvent({ ...base, addMeet: true, account: 'steve-ah' });

    const entry = logCalls.find(c => c.message === 'create_calendar_event');
    expect(entry).toBeDefined();
    expect(entry!.fields).toEqual({
      account: 'steve-ah',
      calendar_id: 'primary',
      event_id: 'evt-meet',
      attendee_count: 0,
      send_updates: 'none',
      add_meet: true,
      meet_status: 'success',
    });
    expect(JSON.stringify(entry!.fields)).not.toContain('meet.google.com');
  });

  it('logs add_meet false and a null meet_status on an ordinary event', async () => {
    api.events.insert.mockResolvedValueOnce(plainOk);

    await createEvent({ ...base });

    const entry = logCalls.find(c => c.message === 'create_calendar_event');
    expect(entry!.fields).toMatchObject({ add_meet: false, meet_status: null });
  });
});

// ---------------------------------------------------------------------------
// extractMeetLink — the one place the link is read out of an event
// ---------------------------------------------------------------------------

describe('extractMeetLink', () => {
  it('prefers hangoutLink', () => {
    expect(
      extractMeetLink({
        hangoutLink: 'https://meet.google.com/aaa-bbbb-ccc',
        conferenceData: {
          entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/zzz-zzzz-zzz' }],
        },
      }),
    ).toBe('https://meet.google.com/aaa-bbbb-ccc');
  });

  it('falls back to the video entry point', () => {
    expect(
      extractMeetLink({
        conferenceData: {
          entryPoints: [
            { entryPointType: 'more', uri: 'https://tel.meet/aaa-bbbb-ccc' },
            { entryPointType: 'video', uri: 'https://meet.google.com/aaa-bbbb-ccc' },
          ],
        },
      }),
    ).toBe('https://meet.google.com/aaa-bbbb-ccc');
  });

  it('ignores a video entry point with no uri', () => {
    expect(
      extractMeetLink({ conferenceData: { entryPoints: [{ entryPointType: 'video' }] } }),
    ).toBeUndefined();
  });

  it('returns undefined when the event carries no conference at all', () => {
    expect(extractMeetLink({ id: 'evt1' })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 403 honesty (chair-queued item 17 / W4-P10)
//
// `withRetry` is shared with the Gmail client and rewrites EVERY non-rate-limit
// 401/403 into "Authentication error … Re-authenticate". For Calendar that is
// usually wrong advice: the common 403s are "the Calendar API is not enabled on
// this project" and "this token was never granted the calendar scopes" — one is
// fixed in the Cloud console, the other by re-consenting to a NAMED scope, and
// neither is a broken login. Re-authenticating a healthy account fixes nothing
// and hides the real cause in the tail of the message.
// ---------------------------------------------------------------------------

/** A Google API error in the shape googleapis actually throws. */
function googleError(status: number, reason: string, message: string): Error {
  return Object.assign(new Error(message), {
    code: status,
    errors: [{ reason }],
    response: { status, data: { error: { errors: [{ reason }] } } },
  });
}

const API_DISABLED_MESSAGE =
  'Google Calendar API has not been used in project 12345 before or it is disabled. '
  + 'Enable it by visiting https://console.developers.google.com/apis/api/calendar-json.googleapis.com/overview?project=12345 then retry.';

describe('calendar 403s tell the truth', () => {
  it('a missing calendar scope names the scope and the re-consent command', async () => {
    api.calendarList.list.mockRejectedValueOnce(
      googleError(403, 'insufficientPermissions', 'Request had insufficient authentication scopes.'),
    );

    await expect(listCalendars('work')).rejects.toThrow(
      /list_calendars needs the https:\/\/www\.googleapis\.com\/auth\/calendar\.calendarlist\.readonly scope/,
    );
  });

  it('names the alias in the re-consent command', async () => {
    api.calendarList.list.mockRejectedValueOnce(
      googleError(403, 'insufficientPermissions', 'Request had insufficient authentication scopes.'),
    );

    await expect(listCalendars('work')).rejects.toThrow(/npm run auth -- work/);
  });

  it('an API-not-enabled 403 says to enable the API, not to re-authenticate', async () => {
    api.events.list.mockRejectedValueOnce(
      googleError(403, 'accessNotConfigured', API_DISABLED_MESSAGE),
    );

    const failure = await listEvents({ calendarId: 'primary' }).catch((e: Error) => e);
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toMatch(/Google Calendar API is not enabled/i);
    expect(message).toContain('console.developers.google.com');
    expect(message).not.toMatch(/Re-authenticate with/);
    expect(message).not.toMatch(/^Authentication error/);
  });

  it('applies to get_freebusy too', async () => {
    api.freebusy.query.mockRejectedValueOnce(
      googleError(403, 'accessNotConfigured', API_DISABLED_MESSAGE),
    );

    await expect(
      queryFreeBusy({ timeMin: '2026-09-01T00:00:00Z', timeMax: '2026-09-02T00:00:00Z' }),
    ).rejects.toThrow(/Google Calendar API is not enabled/i);
  });

  it('applies to create_calendar_event too, and still does not log the write', async () => {
    api.events.insert.mockRejectedValueOnce(
      googleError(403, 'accessNotConfigured', API_DISABLED_MESSAGE),
    );

    await expect(
      createEvent({ summary: 'x', start: '2026-09-01T14:00:00Z', end: '2026-09-01T15:00:00Z' }),
    ).rejects.toThrow(/Google Calendar API is not enabled/i);
    expect(logCalls.find(c => c.message === 'create_calendar_event')).toBeUndefined();
  });

  it('an ordinary forbidden 403 reports itself without re-auth advice', async () => {
    api.calendarList.list.mockRejectedValueOnce(
      googleError(403, 'forbidden', 'The authenticated user cannot access this calendar.'),
    );

    const failure = await listCalendars().catch((e: Error) => e);
    const message = (failure as Error).message;
    expect(message).toContain('cannot access this calendar');
    expect(message).not.toMatch(/Re-authenticate with/);
  });
});

// The rate-limit case is asserted at the translator rather than through
// listCalendars because a rate-limit 403 is RETRYABLE: driving it end to end
// would spend the real 1s + 2s + 4s backoff inside withRetry. What matters is
// that the translator hands it back untouched so that retry still happens and
// Google's own words reach the caller.
describe('translateCalendarError', () => {
  const ctx = { tool: 'list_calendars', scope: CALENDAR_LIST_SCOPE, alias: 'work' };

  it('hands a rate-limit 403 back untouched so withRetry still retries it', () => {
    const err = googleError(403, 'rateLimitExceeded', 'Rate Limit Exceeded');
    expect(translateCalendarError(err, ctx)).toBe(err);
  });

  it('hands a user rate-limit 403 back untouched too', () => {
    const err = googleError(403, 'userRateLimitExceeded', 'User Rate Limit Exceeded');
    expect(translateCalendarError(err, ctx)).toBe(err);
  });

  it('leaves a 401 to the shared re-authenticate path', () => {
    const err = googleError(401, 'authError', 'Invalid Credentials');
    expect(translateCalendarError(err, ctx)).toBe(err);
  });

  it('leaves a 500 untouched so it stays retryable', () => {
    const err = googleError(500, 'backendError', 'Backend Error');
    expect(translateCalendarError(err, ctx)).toBe(err);
  });

  it('recognizes a missing scope from the message alone', () => {
    const err = Object.assign(new Error('Request had insufficient authentication scopes.'), {
      code: 403,
    });
    const out = translateCalendarError(err, ctx) as Error;
    expect(out).not.toBe(err);
    expect(out.message).toContain('calendar.calendarlist.readonly');
    expect(out.message).toContain('npm run auth -- work');
  });
});
