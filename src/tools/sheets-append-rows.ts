import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  type SheetCell,
  type ValueInputOption,
  SHEETS_SCOPE,
  checkValuesPayload,
  getSheetsClient,
  googleValueInputOption,
  outsideAppScopeError,
} from '../sheets/client.js';
import { resolveAccount } from '../config.js';
import { googleApiCall } from '../google-api-error.js';
import { log } from '../log.js';
import { sheetValuesParam, spreadsheetIdParam, valueInputOptionParam } from './shared-params.js';

/**
 * SW2 — add rows to the end of a table without overwriting anything.
 *
 * Two decisions worth stating, because neither is Google's default behaviour
 * and both are visible to whoever reads the sheet afterwards:
 *
 * `insertDataOption: 'INSERT_ROWS'`. Google's default, OVERWRITE, writes into
 * the cells that follow the table whether or not something is already in them,
 * so a note two rows under a table is silently replaced by an append. Inserting
 * makes room instead. Everything else this server does to a file it did not
 * author creates rather than destroys; appending is no exception.
 *
 * `maxRetries: 0`. `values.append` is not idempotent: a 502 can arrive after
 * the rows actually landed, and retrying then adds them a second time and
 * reports only one. That is the same trade `create_google_doc` and
 * `post_chat_message` make — a write other people can see reports its failure
 * rather than guessing.
 */

export const appendSheetRowsParams = {
  spreadsheet_id: spreadsheetIdParam,
  range: z.string().describe('Where the table is, as an anchor rather than a destination: "Sheet1" for the whole sheet, or "Sheet1!A1" to name the table that starts there. Google finds the last row of that table and adds the new rows after it.'),
  values: sheetValuesParam,
  value_input_option: valueInputOptionParam,
  account: z.string().optional().describe('Account alias or email address. Uses default account if not specified.'),
};

/**
 * WRITE: add rows to the end of a table in a Google Sheet this server created.
 */
export function registerAppendSheetRows(server: McpServer): void {
  server.tool(
    'append_sheet_rows',
    'Add rows to the end of a table in a Google Sheet. Nothing existing is overwritten: the rows are INSERTED after the '
    + 'last row of the table, so anything sitting below it is pushed down rather than replaced. '
    + 'It only works on spreadsheets THIS SERVER created: it holds the narrow "drive.file" grant, so a spreadsheet '
    + 'made in Google Sheets by hand or uploaded by another tool is invisible to it and answers "not found". '
    + 'The way to get data into reach is upload_drive_file with convert:true, which lands the file as a real Google Sheet this server owns. '
    + 'The range is an ANCHOR, not a destination — pass "Sheet1", or "Sheet1!A1" to name the table starting there, and Google finds the end of it for you. '
    + 'Values are read as if typed by a person unless you pass value_input_option "raw". Up to 1,000 rows and 10,000 cells per call. '
    + 'The result reports the range Google actually wrote, which is how to tell where the rows landed. '
    + 'This call is NOT retried on a server error: an append that quietly succeeded and then timed out would otherwise add every row twice. '
    + 'To replace a block of cells instead of adding rows, use update_sheet_values.',
    appendSheetRowsParams,
    async ({ spreadsheet_id, range, values, value_input_option, account }) => {
      try {
        const spreadsheetId = (spreadsheet_id ?? '').trim();
        if (!spreadsheetId) {
          throw new Error('append_sheet_rows: spreadsheet_id is required.');
        }
        const a1 = (range ?? '').trim();
        if (!a1) {
          throw new Error(
            'append_sheet_rows: range is required — the sheet or table to append to, '
            + 'e.g. "Sheet1" or "Sheet1!A1".',
          );
        }

        // Measured and refused here: before a client, a token or a request.
        const rows = values as SheetCell[][];
        const size = checkValuesPayload('append_sheet_rows', rows);

        const resolved = resolveAccount(account ?? undefined);
        const sheets = await getSheetsClient(resolved);
        const ctx = {
          tool: 'append_sheet_rows',
          api: 'Google Sheets',
          scope: SHEETS_SCOPE,
          alias: resolved.alias,
        };

        // The shape and destination of the write, never a cell's contents.
        const fields = {
          account: resolved.alias,
          spreadsheet_id: spreadsheetId,
          range: a1,
          rows: size.rows,
          cells: size.cells,
        };
        log('info', 'append_sheet_rows', { ...fields, phase: 'start' });

        let response;
        try {
          response = await googleApiCall(
            ctx,
            async () => {
              try {
                return await sheets.spreadsheets.values.append({
                  spreadsheetId,
                  range: a1,
                  valueInputOption: googleValueInputOption(value_input_option as ValueInputOption | undefined),
                  // Make room for the rows rather than writing over whatever
                  // follows the table. See the note at the top of this file.
                  insertDataOption: 'INSERT_ROWS',
                  requestBody: { values: rows },
                });
              } catch (err: unknown) {
                // On the RAW Google error, for the same reason as the update
                // tool: the reason codes do not survive the shared translation.
                throw outsideAppScopeError(err, { tool: 'append_sheet_rows', spreadsheetId }) ?? err;
              }
            },
            // Not idempotent. A retry after a landed append duplicates the rows.
            { maxRetries: 0 },
          );
        } catch (err: unknown) {
          log('error', 'append_sheet_rows', {
            ...fields,
            phase: 'failed',
            error: err instanceof Error ? err.message : String(err),
          });
          throw err;
        }
        log('info', 'append_sheet_rows', { ...fields, phase: 'done' });

        const data = response.data ?? {};
        const updates = data.updates ?? {};

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: true,
                spreadsheetId,
                // Where the table was before the append — the anchor Google
                // resolved, which is the answer to "did it find the right one?"
                tableRange: data.tableRange ?? null,
                updatedRange: updates.updatedRange ?? null,
                updatedRows: updates.updatedRows ?? 0,
                updatedColumns: updates.updatedColumns ?? 0,
                updatedCells: updates.updatedCells ?? 0,
              }, null, 2),
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
