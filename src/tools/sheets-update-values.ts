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
 * SW1 — write a block of values into a named range.
 *
 * This is the OVERWRITING half of the Sheets pair, and the tool says so in its
 * own description: whatever is in the range goes, and the only way back is the
 * spreadsheet's version history. That is the honest description of
 * `spreadsheets.values.update`, and dressing it up as "set" or "write" would
 * hide the part a caller needs to weigh.
 *
 * It is retried on a 5xx, unlike its append sibling: writing the same values to
 * the same range twice leaves the sheet exactly as writing them once does, so a
 * gateway timeout that actually landed costs nothing to repeat.
 */

export const updateSheetValuesParams = {
  spreadsheet_id: spreadsheetIdParam,
  range: z.string().describe('The range to write, in A1 notation, e.g. "Sheet1!A1:C10" or "Sheet1!A1" for the top-left corner of the block. The sheet name is part of it: without one, Google writes to the first sheet.'),
  values: sheetValuesParam,
  value_input_option: valueInputOptionParam,
  account: z.string().optional().describe('Account alias or email address. Uses default account if not specified.'),
};

/**
 * WRITE: overwrite a range of cells in a Google Sheet this server created.
 */
export function registerUpdateSheetValues(server: McpServer): void {
  server.tool(
    'update_sheet_values',
    'Write values into a named range of a Google Sheet. This OVERWRITES whatever is currently in that range — '
    + 'every cell the range covers is replaced, and the only way back is the spreadsheet\'s own version history. '
    + 'It only works on spreadsheets THIS SERVER created: it holds the narrow "drive.file" grant, so a spreadsheet '
    + 'made in Google Sheets by hand or uploaded by another tool is invisible to it and answers "not found". '
    + 'The way to get data into reach is upload_drive_file with convert:true, which lands the file as a real Google Sheet this server owns. '
    + 'Values are read as if typed by a person unless you pass value_input_option "raw", so formulas and percentages behave as written. '
    + 'Up to 1,000 rows and 10,000 cells per call. The result reports the range, rows and cells Google says it actually changed — read it rather than assuming. '
    + 'To ADD rows to the end of a table instead of replacing a block, use append_sheet_rows.',
    updateSheetValuesParams,
    async ({ spreadsheet_id, range, values, value_input_option, account }) => {
      try {
        const spreadsheetId = (spreadsheet_id ?? '').trim();
        if (!spreadsheetId) {
          throw new Error('update_sheet_values: spreadsheet_id is required.');
        }
        const a1 = (range ?? '').trim();
        if (!a1) {
          throw new Error(
            'update_sheet_values: range is required, in A1 notation, e.g. "Sheet1!A1:C10". '
            + 'Without one there is no saying which cells would be overwritten.',
          );
        }

        // Measured and refused here: before a client, a token or a request.
        const rows = values as SheetCell[][];
        const size = checkValuesPayload('update_sheet_values', rows);

        const resolved = resolveAccount(account ?? undefined);
        const sheets = await getSheetsClient(resolved);
        const ctx = {
          tool: 'update_sheet_values',
          api: 'Google Sheets',
          scope: SHEETS_SCOPE,
          alias: resolved.alias,
        };

        // Everything a write log should carry and nothing it should not: the
        // shape and destination of the write, never a cell's contents.
        const fields = {
          account: resolved.alias,
          spreadsheet_id: spreadsheetId,
          range: a1,
          rows: size.rows,
          cells: size.cells,
        };
        log('info', 'update_sheet_values', { ...fields, phase: 'start' });

        let response;
        try {
          response = await googleApiCall(ctx, async () => {
            try {
              return await sheets.spreadsheets.values.update({
                spreadsheetId,
                range: a1,
                valueInputOption: googleValueInputOption(value_input_option as ValueInputOption | undefined),
                requestBody: { values: rows },
              });
            } catch (err: unknown) {
              // Inside the call, on the RAW Google error: the reason codes that
              // tell an out-of-reach spreadsheet apart from a missing scope or a
              // disabled API do not survive the shared translation. What comes
              // back carries no status, so neither the retry loop nor the
              // translator touches it again — and every other failure travels on
              // to the translator exactly as before.
              throw outsideAppScopeError(err, { tool: 'update_sheet_values', spreadsheetId }) ?? err;
            }
          });
        } catch (err: unknown) {
          log('error', 'update_sheet_values', {
            ...fields,
            phase: 'failed',
            error: err instanceof Error ? err.message : String(err),
          });
          throw err;
        }
        log('info', 'update_sheet_values', { ...fields, phase: 'done' });

        const data = response.data ?? {};

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: true,
                spreadsheetId,
                updatedRange: data.updatedRange ?? null,
                updatedRows: data.updatedRows ?? 0,
                updatedColumns: data.updatedColumns ?? 0,
                updatedCells: data.updatedCells ?? 0,
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
