import { google } from 'googleapis';
import type { calendar_v3 } from 'googleapis';
import type { Auth } from 'googleapis';
import { type AccountConfig, resolveAccount } from '../config.js';
import { getAuthClient } from '../gmail/auth.js';
import { googleApiCall, translateGoogleApiError } from '../google-api-error.js';
import type { ScopeErrorContext } from '../scope-error.js';
import { log } from '../log.js';

// ---------------------------------------------------------------------------
// Client cache: Google Calendar API client per account with 50-min TTL.
// Mirrors the caching idiom in src/gmail/client.ts and the Chat/Drive/Docs
// factories. Everything here is read-only EXCEPT createEvent, which is the
// one mutating call in this module and is logged like every other
// state-changing path in the server.
// ---------------------------------------------------------------------------

interface CachedClient {
  client: Auth.OAuth2Client;
  calendar: calendar_v3.Calendar;
  expiresAt: number;
}

const CLIENT_CACHE = new Map<string, CachedClient>();
const CLIENT_TTL_MS = 50 * 60 * 1000; // 50 minutes

/** Default page size for event listing. */
export const DEFAULT_EVENT_PAGE_SIZE = 50;
/** Hard ceiling for event listing (the contract's cap, below the API's 2500). */
export const MAX_EVENT_PAGE_SIZE = 250;

/**
 * Get an authenticated Google Calendar API client for an account.
 * Reuses the shared OAuth client + per-account token store via getAuthClient.
 * Caches the built client per account with a 50-min TTL.
 */
export async function getCalendarClient(
  account?: string | AccountConfig,
): Promise<calendar_v3.Calendar> {
  const resolved = typeof account === 'string' || account === undefined
    ? resolveAccount(account)
    : account;

  const cacheKey = resolved.email;
  const cached = CLIENT_CACHE.get(cacheKey);

  if (cached && Date.now() < cached.expiresAt) {
    return cached.calendar;
  }

  const authClient = await getAuthClient(resolved);
  const calendar = google.calendar({ version: 'v3', auth: authClient });

  CLIENT_CACHE.set(cacheKey, {
    client: authClient,
    calendar,
    expiresAt: Date.now() + CLIENT_TTL_MS,
  });

  return calendar;
}

/** Resolve an account input to its config record (string alias/email or object). */
function resolve(account?: string | AccountConfig): AccountConfig {
  return typeof account === 'string' || account === undefined
    ? resolveAccount(account)
    : account;
}

// ---------------------------------------------------------------------------
// 403 honesty — chair-queued item 17 / W4-P10
// ---------------------------------------------------------------------------

/** The scope each Calendar call needs, quoted back in a missing-scope error. */
export const CALENDAR_LIST_SCOPE = 'https://www.googleapis.com/auth/calendar.calendarlist.readonly';
export const CALENDAR_EVENTS_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
export const CALENDAR_FREEBUSY_SCOPE = 'https://www.googleapis.com/auth/calendar.freebusy';

/** The API's human name, as it should read in a sentence and in the console. */
const CALENDAR_API = 'Google Calendar';

/**
 * Turn a Calendar failure into advice that is actually true.
 *
 * The logic is the shared one in `src/google-api-error.ts` — Chat, Drive and
 * Docs need exactly the same translation, and W13 built it here first. This
 * wrapper survives because the Calendar call sites and their tests name it, and
 * because it fixes the API label so no call site can get it wrong.
 */
export function translateCalendarError(err: unknown, ctx: ScopeErrorContext): unknown {
  return translateGoogleApiError(err, { ...ctx, api: CALENDAR_API });
}

/**
 * Run one Calendar API call with retries AND honest error reporting.
 * The translation sits inside the retry so it reads the raw Google error.
 */
async function calendarCall<T>(ctx: ScopeErrorContext, fn: () => Promise<T>): Promise<T> {
  return googleApiCall({ ...ctx, api: CALENDAR_API }, fn);
}

// ---------------------------------------------------------------------------
// Read operations
// ---------------------------------------------------------------------------

export interface CalendarSummary {
  id: string;
  summary: string;
  description?: string;
  timeZone?: string;
  accessRole?: string;
  primary?: boolean;
  selected?: boolean;
}

/**
 * READ-ONLY: list the calendars visible to the account (calendarList.list),
 * paginating until exhausted.
 */
export async function listCalendars(
  account?: string | AccountConfig,
): Promise<CalendarSummary[]> {
  const resolved = resolve(account);
  const calendar = await getCalendarClient(resolved);
  const ctx = { tool: 'list_calendars', scope: CALENDAR_LIST_SCOPE, alias: resolved.alias };
  const out: CalendarSummary[] = [];
  let pageToken: string | undefined;

  do {
    const response = await calendarCall(ctx, () =>
      calendar.calendarList.list({ maxResults: 250, pageToken, showHidden: false }),
    );
    const page = response.data.items ?? [];
    for (const item of page) {
      if (!item.id) continue;
      out.push({
        id: item.id,
        summary: item.summary ?? item.id,
        ...(item.description ? { description: item.description } : {}),
        ...(item.timeZone ? { timeZone: item.timeZone } : {}),
        ...(item.accessRole ? { accessRole: item.accessRole } : {}),
        ...(item.primary ? { primary: true } : {}),
        ...(item.selected ? { selected: true } : {}),
      });
    }
    pageToken = response.data.nextPageToken ?? undefined;
    if (page.length === 0) break;
  } while (pageToken);

  return out;
}

export interface EventSummary {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: calendar_v3.Schema$EventDateTime;
  end?: calendar_v3.Schema$EventDateTime;
  allDay: boolean;
  organizer?: string;
  attendees?: { email: string; responseStatus?: string; optional?: boolean }[];
  hangoutLink?: string;
  htmlLink?: string;
  recurringEventId?: string;
}

export interface ListEventsOptions {
  calendarId?: string;
  timeMin?: string;
  timeMax?: string;
  query?: string;
  maxResults?: number;
  pageToken?: string;
  account?: string | AccountConfig;
}

function toEventSummary(event: calendar_v3.Schema$Event): EventSummary {
  const attendees = (event.attendees ?? [])
    .filter(a => !!a.email)
    .map(a => ({
      email: a.email as string,
      ...(a.responseStatus ? { responseStatus: a.responseStatus } : {}),
      ...(a.optional ? { optional: true } : {}),
    }));

  return {
    id: event.id ?? '',
    ...(event.status ? { status: event.status } : {}),
    ...(event.summary ? { summary: event.summary } : {}),
    ...(event.description ? { description: event.description } : {}),
    ...(event.location ? { location: event.location } : {}),
    ...(event.start ? { start: event.start } : {}),
    ...(event.end ? { end: event.end } : {}),
    allDay: !!event.start?.date && !event.start?.dateTime,
    ...(event.organizer?.email ? { organizer: event.organizer.email } : {}),
    ...(attendees.length > 0 ? { attendees } : {}),
    ...(event.hangoutLink ? { hangoutLink: event.hangoutLink } : {}),
    ...(event.htmlLink ? { htmlLink: event.htmlLink } : {}),
    ...(event.recurringEventId ? { recurringEventId: event.recurringEventId } : {}),
  };
}

/**
 * READ-ONLY: list events on one calendar. Recurring events are expanded into
 * their individual instances (singleEvents) and ordered by start time, which
 * is the only ordering the API allows alongside singleEvents.
 */
export async function listEvents(
  opts: ListEventsOptions = {},
): Promise<{ events: EventSummary[]; nextPageToken?: string; calendarId: string }> {
  const calendarId = opts.calendarId || 'primary';
  const resolved = resolve(opts.account);
  const calendar = await getCalendarClient(resolved);
  const ctx = { tool: 'list_calendar_events', scope: CALENDAR_EVENTS_SCOPE, alias: resolved.alias };

  const requested = opts.maxResults ?? DEFAULT_EVENT_PAGE_SIZE;
  const maxResults = Math.max(1, Math.min(requested, MAX_EVENT_PAGE_SIZE));

  const response = await calendarCall(ctx, () =>
    calendar.events.list({
      calendarId,
      maxResults,
      singleEvents: true,
      orderBy: 'startTime',
      timeMin: opts.timeMin || undefined,
      timeMax: opts.timeMax || undefined,
      q: opts.query || undefined,
      pageToken: opts.pageToken || undefined,
    }),
  );

  const events = (response.data.items ?? []).map(toEventSummary);
  const nextPageToken = response.data.nextPageToken ?? undefined;

  return {
    calendarId,
    events,
    ...(nextPageToken ? { nextPageToken } : {}),
  };
}

export interface FreeBusyOptions {
  timeMin: string;
  timeMax: string;
  calendarIds?: string[];
  account?: string | AccountConfig;
}

export interface FreeBusyResult {
  timeMin: string;
  timeMax: string;
  calendars: Record<
    string,
    { busy: { start?: string; end?: string }[]; errors?: { domain?: string; reason?: string }[] }
  >;
}

/**
 * READ-ONLY: free/busy windows across one or more calendars.
 * Per-calendar errors (no access, unknown id) are returned rather than thrown —
 * one unreadable calendar must not blank out the others.
 */
export async function queryFreeBusy(opts: FreeBusyOptions): Promise<FreeBusyResult> {
  const resolved = resolve(opts.account);
  const calendar = await getCalendarClient(resolved);
  const ctx = { tool: 'get_freebusy', scope: CALENDAR_FREEBUSY_SCOPE, alias: resolved.alias };
  const ids = opts.calendarIds && opts.calendarIds.length > 0 ? opts.calendarIds : ['primary'];

  const response = await calendarCall(ctx, () =>
    calendar.freebusy.query({
      requestBody: {
        timeMin: opts.timeMin,
        timeMax: opts.timeMax,
        items: ids.map(id => ({ id })),
      },
    }),
  );

  const calendars: FreeBusyResult['calendars'] = {};
  const raw = response.data.calendars ?? {};
  for (const [id, value] of Object.entries(raw)) {
    calendars[id] = {
      busy: (value?.busy ?? []).map(b => ({
        ...(b.start ? { start: b.start } : {}),
        ...(b.end ? { end: b.end } : {}),
      })),
      ...(value?.errors && value.errors.length > 0
        ? { errors: value.errors.map(e => ({ domain: e.domain ?? undefined, reason: e.reason ?? undefined })) }
        : {}),
    };
  }

  return {
    timeMin: response.data.timeMin ?? opts.timeMin,
    timeMax: response.data.timeMax ?? opts.timeMax,
    calendars,
  };
}

// ---------------------------------------------------------------------------
// Write operation — the only mutating call in this module
// ---------------------------------------------------------------------------

export type SendUpdates = 'all' | 'externalOnly' | 'none';

export interface CreateEventOptions {
  summary: string;
  start: string;
  end: string;
  allDay?: boolean;
  description?: string;
  location?: string;
  attendees?: string[];
  calendarId?: string;
  timeZone?: string;
  sendUpdates?: SendUpdates;
  account?: string | AccountConfig;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Build one EventDateTime. An all-day event uses `date` (YYYY-MM-DD); a timed
 * event uses `dateTime` (RFC3339). Passing a date-only string for a timed event
 * is a caller error rather than something to silently reinterpret.
 */
export function buildEventDateTime(
  value: string,
  allDay: boolean,
  timeZone: string | undefined,
  field: 'start' | 'end',
): calendar_v3.Schema$EventDateTime {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`create_calendar_event: ${field} is required`);

  if (allDay) {
    if (!DATE_ONLY.test(trimmed)) {
      throw new Error(
        `create_calendar_event: all_day events need ${field} as a YYYY-MM-DD date, got "${trimmed}"`,
      );
    }
    return { date: trimmed };
  }

  if (DATE_ONLY.test(trimmed)) {
    throw new Error(
      `create_calendar_event: ${field} "${trimmed}" is a date with no time. ` +
      `Pass a full ISO 8601 timestamp (e.g. 2026-09-01T14:00:00-04:00), or set all_day: true.`,
    );
  }

  if (Number.isNaN(Date.parse(trimmed))) {
    throw new Error(`create_calendar_event: ${field} "${trimmed}" is not a valid ISO 8601 timestamp`);
  }

  return { dateTime: trimmed, ...(timeZone ? { timeZone } : {}) };
}

/**
 * Create an event. `sendUpdates` defaults to 'none' — the default NEVER emails
 * anyone. 'all' is an outward act: Google mails every attendee an invitation.
 */
export async function createEvent(opts: CreateEventOptions): Promise<{
  id: string;
  htmlLink?: string;
  status?: string;
  summary?: string;
  start?: calendar_v3.Schema$EventDateTime;
  end?: calendar_v3.Schema$EventDateTime;
  attendees?: { email: string; responseStatus?: string }[];
  calendarId: string;
  sendUpdates: SendUpdates;
  notice: string;
}> {
  const resolved = resolve(opts.account);
  const calendar = await getCalendarClient(resolved);
  const calendarId = opts.calendarId || 'primary';
  const sendUpdates: SendUpdates = opts.sendUpdates ?? 'none';
  const allDay = opts.allDay ?? false;

  if (!opts.summary || !opts.summary.trim()) {
    throw new Error('create_calendar_event: summary is required');
  }

  const start = buildEventDateTime(opts.start, allDay, opts.timeZone, 'start');
  const end = buildEventDateTime(opts.end, allDay, opts.timeZone, 'end');

  // Each endpoint is valid on its own; the RANGE was never checked, so an
  // inverted one reached the API and came back as an opaque Google error.
  // get_freebusy already refuses this — same rule here.
  const startMs = Date.parse(opts.start.trim());
  const endMs = Date.parse(opts.end.trim());
  if (allDay) {
    // An all-day end date is exclusive, so end === start is a one-day event.
    if (endMs < startMs) {
      throw new Error(
        `create_calendar_event: end "${opts.end}" is before start "${opts.start}"`,
      );
    }
  } else if (endMs <= startMs) {
    throw new Error(
      `create_calendar_event: end "${opts.end}" must be after start "${opts.start}"`,
    );
  }

  const attendees = (opts.attendees ?? [])
    .map(email => email.trim())
    .filter(email => email.length > 0);

  const response = await calendarCall(
    { tool: 'create_calendar_event', scope: CALENDAR_EVENTS_SCOPE, alias: resolved.alias },
    () =>
      calendar.events.insert({
        calendarId,
        sendUpdates,
        requestBody: {
          summary: opts.summary,
          ...(opts.description ? { description: opts.description } : {}),
          ...(opts.location ? { location: opts.location } : {}),
          start,
          end,
          ...(attendees.length > 0 ? { attendees: attendees.map(email => ({ email })) } : {}),
        },
      }),
  );

  const event = response.data;

  // Destructive/outward path: logged like send, trash and delete. Target ids
  // only — never attendee addresses or event bodies.
  log('info', 'create_calendar_event', {
    account: resolved.alias,
    calendar_id: calendarId,
    event_id: event.id ?? null,
    attendee_count: attendees.length,
    send_updates: sendUpdates,
  });

  return {
    id: event.id ?? '',
    ...(event.htmlLink ? { htmlLink: event.htmlLink } : {}),
    ...(event.status ? { status: event.status } : {}),
    ...(event.summary ? { summary: event.summary } : {}),
    ...(event.start ? { start: event.start } : {}),
    ...(event.end ? { end: event.end } : {}),
    ...(event.attendees
      ? {
          attendees: event.attendees
            .filter(a => !!a.email)
            .map(a => ({
              email: a.email as string,
              ...(a.responseStatus ? { responseStatus: a.responseStatus } : {}),
            })),
        }
      : {}),
    calendarId,
    sendUpdates,
    notice:
      sendUpdates === 'none'
        ? 'No invitation emails were sent (send_updates: "none"). Attendees see the event only if they check their calendar.'
        : `Google emailed invitations (send_updates: "${sendUpdates}").`,
  };
}
