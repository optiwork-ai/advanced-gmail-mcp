import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  DEFAULT_EVENT_PAGE_SIZE,
  MAX_EVENT_PAGE_SIZE,
  listEvents,
} from '../calendar/client.js';

export const listCalendarEventsParams = {
  calendar_id: z.string().optional().describe('Calendar id from list_calendars. Defaults to "primary" (the account\'s own calendar).'),
  time_min: z.string().optional().describe('Only events ending after this ISO 8601 timestamp, e.g. "2026-09-01T00:00:00Z". Omit for no lower bound.'),
  time_max: z.string().optional().describe('Only events starting before this ISO 8601 timestamp. Omit for no upper bound.'),
  query: z.string().optional().describe('Free-text search across the event summary, description, location and attendee names.'),
  max_results: z.number().optional().describe(`Maximum events to return in one page (default: ${DEFAULT_EVENT_PAGE_SIZE}, max: ${MAX_EVENT_PAGE_SIZE}). Use page_token for the next page.`),
  page_token: z.string().optional().describe('nextPageToken from a previous call, to fetch the next page.'),
  account: z.string().optional().describe('Account alias or email address. Uses default account if not specified.'),
};

/**
 * READ-ONLY: list events on one calendar.
 */
export function registerListCalendarEvents(server: McpServer): void {
  server.tool(
    'list_calendar_events',
    `List events on a Google Calendar. Read-only — nothing is created or changed. Recurring events are expanded into individual instances and returned in start-time order. Returns id, summary, start/end (with allDay), location, organizer, attendees and htmlLink, plus nextPageToken when more remain. Default page size ${DEFAULT_EVENT_PAGE_SIZE}, maximum ${MAX_EVENT_PAGE_SIZE}.`,
    listCalendarEventsParams,
    async ({ calendar_id, time_min, time_max, query, max_results, page_token, account }) => {
      try {
        const result = await listEvents({
          calendarId: calendar_id ?? undefined,
          timeMin: time_min ?? undefined,
          timeMax: time_max ?? undefined,
          query: query ?? undefined,
          maxResults: max_results ?? undefined,
          pageToken: page_token ?? undefined,
          account: account ?? undefined,
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ count: result.events.length, ...result }, null, 2),
            },
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
