import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { listCalendars } from '../calendar/client.js';

export const listCalendarsParams = {
  account: z.string().optional().describe('Account alias or email address. Uses default account if not specified.'),
};

/**
 * READ-ONLY: list the calendars visible to the account.
 */
export function registerListCalendars(server: McpServer): void {
  server.tool(
    'list_calendars',
    'List the Google Calendars this account can see (its own plus any shared with it). Read-only. Returns each calendar\'s id, summary, timeZone, accessRole, and whether it is the primary calendar. Use the returned id as calendar_id for list_calendar_events, get_freebusy or create_calendar_event.',
    listCalendarsParams,
    async ({ account }) => {
      try {
        const calendars = await listCalendars(account ?? undefined);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ count: calendars.length, calendars }, null, 2),
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
