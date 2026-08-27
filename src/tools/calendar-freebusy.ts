import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { queryFreeBusy } from '../calendar/client.js';

export const getFreebusyParams = {
  time_min: z.string().describe('Start of the window to check, as an ISO 8601 timestamp, e.g. "2026-09-01T09:00:00-04:00". Required.'),
  time_max: z.string().describe('End of the window to check, as an ISO 8601 timestamp. Required.'),
  calendar_ids: z.array(z.string()).optional().describe('Calendar ids to check (from list_calendars). Defaults to ["primary"].'),
  account: z.string().optional().describe('Account alias or email address. Uses default account if not specified.'),
};

/**
 * READ-ONLY: free/busy windows across one or more calendars.
 */
export function registerGetFreebusy(server: McpServer): void {
  server.tool(
    'get_freebusy',
    'Check when calendars are busy in a time window. Read-only. Returns per-calendar busy intervals (no event titles — free/busy only). A calendar the account cannot read comes back with an errors entry instead of failing the whole query. Use this to find open slots before creating an event.',
    getFreebusyParams,
    async ({ time_min, time_max, calendar_ids, account }) => {
      try {
        if (Number.isNaN(Date.parse(time_min))) {
          throw new Error(`get_freebusy: time_min "${time_min}" is not a valid ISO 8601 timestamp`);
        }
        if (Number.isNaN(Date.parse(time_max))) {
          throw new Error(`get_freebusy: time_max "${time_max}" is not a valid ISO 8601 timestamp`);
        }
        if (Date.parse(time_max) <= Date.parse(time_min)) {
          throw new Error('get_freebusy: time_max must be after time_min');
        }

        const result = await queryFreeBusy({
          timeMin: time_min,
          timeMax: time_max,
          calendarIds: calendar_ids ?? undefined,
          account: account ?? undefined,
        });

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
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
