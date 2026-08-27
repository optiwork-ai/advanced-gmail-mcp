import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getVacation, setVacation } from '../gmail/settings-api.js';

const SCOPE_NOTE =
  'REQUIRES the "gmail.settings.basic" scope, added on 2026-08-27: an account whose token '
  + 'predates it answers 403 until it re-consents with "npm run auth -- <alias>". A 403 from '
  + 'this tool means the permission was never granted, not that the login is broken.';

const accountParam = z.string().optional().describe('Account alias or email address. Uses default account if not specified.');

export const getVacationParams = { account: accountParam };

export const setVacationParams = {
  enable: z.boolean().describe('true turns the vacation responder ON; false turns it OFF. Turning it off KEEPS the saved subject and message, and never needs confirm.'),
  confirm: z.boolean().optional().describe('Required to be true alongside enable: true, and ignored otherwise. Enabling the responder makes the account send mail outward on its own, so pass this ONLY after the user has explicitly asked for the responder to be turned on — never to clear the error.'),
  subject: z.string().optional().describe('Subject line of the automatic reply. Omit to keep whatever is already saved.'),
  body: z.string().optional().describe('The automatic reply text. Supplying it REPLACES the saved message in both the plain-text and HTML forms Gmail stores, so the reply that goes out is always the text you passed. Omit to keep whatever is already saved; required the first time the responder is enabled on an account.'),
  is_html: z.boolean().optional().describe('Treat body as HTML rather than plain text (default: false). Either way both stored forms are rewritten from it.'),
  start_time: z.string().optional().describe('ISO 8601 date or timestamp for when the responder starts, e.g. "2026-09-01". Omit for "immediately".'),
  end_time: z.string().optional().describe('ISO 8601 date or timestamp for when the responder stops. Omit for "until turned off" — worth setting, since an unbounded responder is the one people forget.'),
  restrict_to_contacts: z.boolean().optional().describe('Reply only to people in the account\'s contacts.'),
  restrict_to_domain: z.boolean().optional().describe('Reply only to senders inside the account\'s own Workspace domain.'),
  account: accountParam,
};

/**
 * The vacation responder. Reading it is harmless; enabling it makes the
 * account send mail on its own, which is why the description says so first.
 */
export function registerVacationTools(server: McpServer): void {
  server.tool(
    'get_vacation',
    'Read the account\'s vacation-responder (out-of-office) settings: whether it is on, its subject and message, any start/end window, and whether replies are restricted to contacts or to the Workspace domain. Read-only. '
    + SCOPE_NOTE,
    getVacationParams,
    async ({ account }) => {
      try {
        const result = await getVacation(account ?? undefined);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
      }
    },
  );

  server.tool(
    'set_vacation',
    'Turn the vacation responder (out-of-office auto-reply) on or off. '
    + 'ENABLING IT IS AN OUTWARD ACT: while it is on, Gmail replies automatically, from this account, to people who write in — without any further call to this server. '
    + 'TWO RULES GOVERN ENABLING. (1) enable: true is REFUSED unless confirm: true is passed as well, and you may pass confirm only after the user has explicitly asked for the responder to be turned on. (2) enable: true is REFUSED when the saved responder window already ended — an old responder is not silently brought back to life; pass a new start_time and end_time for the absence you actually mean. '
    + 'Turning it OFF (enable: false) needs neither: the safe direction is never harder than the dangerous one. '
    + 'Settings are merged, not replaced: omitted fields keep their saved values, so turning the responder off does not erase the message, and changing the subject does not blank the body. '
    + 'The result carries a notice stating exactly what is now switched on. '
    + SCOPE_NOTE,
    setVacationParams,
    async ({ enable, confirm, subject, body, is_html, start_time, end_time, restrict_to_contacts, restrict_to_domain, account }) => {
      try {
        const result = await setVacation({
          enable,
          confirm: confirm ?? undefined,
          subject: subject ?? undefined,
          body: body ?? undefined,
          isHtml: is_html ?? undefined,
          startTime: start_time ?? undefined,
          endTime: end_time ?? undefined,
          restrictToContacts: restrict_to_contacts ?? undefined,
          restrictToDomain: restrict_to_domain ?? undefined,
          account: account ?? undefined,
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: true, ...result }, null, 2) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
      }
    },
  );
}
