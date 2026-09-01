import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createEvent } from '../calendar/client.js';

export const createCalendarEventParams = {
  summary: z.string().describe('Event title. Required.'),
  start: z.string().describe('Start time. For a timed event, a full ISO 8601 timestamp, e.g. "2026-09-01T14:00:00-04:00". For an all-day event (all_day: true), a "YYYY-MM-DD" date.'),
  end: z.string().describe('End time, in the same form as start. For an all-day event the end date is EXCLUSIVE, as Google Calendar defines it: a one-day event on 2026-09-01 ends 2026-09-02.'),
  all_day: z.boolean().optional().describe('Set true for an all-day event; start and end must then be "YYYY-MM-DD" dates (default: false).'),
  description: z.string().optional().describe('Event description / body.'),
  location: z.string().optional().describe('Free-text location.'),
  attendees: z.array(z.string()).optional().describe('Attendee email addresses. Adding an attendee does NOT email them unless send_updates is "all" or "externalOnly".'),
  add_meet: z.boolean().optional().describe('Set true to attach a Google Meet video room to the event and get its link back. The result then carries meetLink (the room) and meetStatus: "success" when the room is ready, "pending" when Google is still building it (no link yet — read it a minute later with list_calendar_events), or "failure" when Google could not attach one. This emails NOBODY: send_updates alone decides that.'),
  send_updates: z.enum(['none', 'all', 'externalOnly']).optional().describe('Whether Google emails the attendees about this event. DEFAULT "none" — nobody is emailed, and the event simply appears on their calendar if they are on the invite. "all" EMAILS EVERY ATTENDEE an invitation, which is an outward-facing act that leaves this system; "externalOnly" emails only attendees outside your Workspace domain. Leave unset unless you have been told to notify people.'),
  calendar_id: z.string().optional().describe('Calendar id to create the event on (from list_calendars). Defaults to "primary".'),
  time_zone: z.string().optional().describe('IANA time zone for a timed event, e.g. "America/New_York". Optional when start/end carry an explicit UTC offset.'),
  account: z.string().optional().describe('Account alias or email address. Uses default account if not specified.'),
};

/**
 * Create a calendar event. The only mutating calendar tool.
 */
export function registerCreateCalendarEvent(server: McpServer): void {
  server.tool(
    'create_calendar_event',
    'Create an event on a Google Calendar. This writes to the calendar. send_updates defaults to "none", which sends NO email to anyone; passing "all" makes Google EMAIL every attendee an invitation (an outward act — only do it when explicitly asked). add_meet: true also attaches a Google Meet room and returns its link, which emails nobody by itself. Returns the created event id, htmlLink, resolved start/end and attendees, the Meet link and its status when one was asked for, plus a notice stating whether anyone was emailed and how the room ended up.',
    createCalendarEventParams,
    async ({
      summary,
      start,
      end,
      all_day,
      description,
      location,
      attendees,
      add_meet,
      send_updates,
      calendar_id,
      time_zone,
      account,
    }) => {
      try {
        const result = await createEvent({
          summary,
          start,
          end,
          allDay: all_day ?? false,
          description: description ?? undefined,
          location: location ?? undefined,
          attendees: attendees ?? undefined,
          addMeet: add_meet ?? false,
          sendUpdates: send_updates ?? 'none',
          calendarId: calendar_id ?? undefined,
          timeZone: time_zone ?? undefined,
          account: account ?? undefined,
        });

        return {
          content: [
            { type: 'text' as const, text: JSON.stringify({ success: true, ...result }, null, 2) },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
