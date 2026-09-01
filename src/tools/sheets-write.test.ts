/**
 * SW — the two Sheets write tools, exercised through the handlers the MCP
 * server actually registers.
 *
 * `googleapis`, the OAuth client, the account config and the logger are stubbed;
 * `src/sheets/client.ts` and both tool modules are the REAL ones, so what these
 * pin is the request that would go to Google and the words that come back — not
 * a mock of our own design. Nothing here touches the network, a token file or a
 * real spreadsheet.
 *
 * The scope story matters to most of it: these tools ride `drive.file`, the
 * grant every alias already holds, and that grant reaches ONLY spreadsheets
 * this server created. Google answers for anything else exactly as it would for
 * a file that does not exist, so the tool has to explain the difference itself.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = {
  spreadsheets: {
    values: { update: vi.fn(), append: vi.fn() },
  },
};

vi.mock('googleapis', () => ({
  google: { sheets: () => api },
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
  MAX_SHEET_CELLS_PER_CALL,
  MAX_SHEET_ROWS_PER_CALL,
  SHEETS_SCOPE,
  getSheetsClient,
} = await import('../sheets/client.js');

const { registerUpdateSheetValues } = await import('./sheets-update-values.js');
const { registerAppendSheetRows } = await import('./sheets-append-rows.js');

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function capture(register: (server: never) => void): { name: string; description: string; handler: Handler } {
  let captured: { name: string; description: string; handler: Handler } | undefined;
  const server = {
    tool: (name: string, description: string, _params: unknown, handler: Handler) => {
      captured = { name, description, handler };
    },
  };
  register(server as never);
  if (!captured) throw new Error('the tool registered nothing');
  return captured;
}

/** A Google API error in the shape googleapis actually throws. */
function googleError(status: number, reason: string, message: string): Error {
  return Object.assign(new Error(message), {
    code: status,
    errors: [{ reason }],
    response: { status, data: { error: { errors: [{ reason }] } } },
  });
}

const UPDATE_OK = {
  data: {
    spreadsheetId: 'sheet-1',
    updatedRange: 'Sheet1!A1:B2',
    updatedRows: 2,
    updatedColumns: 2,
    updatedCells: 4,
  },
};

const APPEND_OK = {
  data: {
    spreadsheetId: 'sheet-1',
    tableRange: 'Sheet1!A1:B3',
    updates: {
      updatedRange: 'Sheet1!A4:B5',
      updatedRows: 2,
      updatedColumns: 2,
      updatedCells: 4,
    },
  },
};

const ROWS = [['name', 'total'], ['widgets', 12]];

beforeEach(() => {
  api.spreadsheets.values.update.mockReset();
  api.spreadsheets.values.append.mockReset();
  logCalls.length = 0;
});

// ---------------------------------------------------------------------------
// The module itself — no new OAuth scope, by design
// ---------------------------------------------------------------------------

describe('the Sheets client', () => {
  it('rides drive.file, so no alias has to re-consent for this to work', () => {
    // Steve's ruling, 2026-09-01: no new OAuth scope. The consequence — writes
    // reach only spreadsheets this server created — is the designed boundary,
    // and every error message below has to be honest about it.
    expect(SHEETS_SCOPE).toBe('https://www.googleapis.com/auth/drive.file');
  });

  it('caches one client per account, like every other service client here', async () => {
    const a = await getSheetsClient('cache-probe@example.com');
    const b = await getSheetsClient('cache-probe@example.com');
    expect(a).toBe(b);
  });

  it('states the payload ceilings as numbers a caller can plan around', () => {
    expect(MAX_SHEET_CELLS_PER_CALL).toBe(10_000);
    expect(MAX_SHEET_ROWS_PER_CALL).toBe(1_000);
  });
});

// ---------------------------------------------------------------------------
// update_sheet_values
// ---------------------------------------------------------------------------

describe('update_sheet_values', () => {
  it('writes the values to the named range', async () => {
    api.spreadsheets.values.update.mockResolvedValue(UPDATE_OK);
    const { handler } = capture(registerUpdateSheetValues as (server: never) => void);

    await handler({ spreadsheet_id: 'sheet-1', range: 'Sheet1!A1:B2', values: ROWS });

    const args = api.spreadsheets.values.update.mock.calls[0][0];
    expect(args.spreadsheetId).toBe('sheet-1');
    expect(args.range).toBe('Sheet1!A1:B2');
    expect(args.requestBody.values).toEqual(ROWS);
  });

  it('defaults to user_entered, so "=SUM(A1:A2)" and "5%" behave as typed', async () => {
    api.spreadsheets.values.update.mockResolvedValue(UPDATE_OK);
    const { handler } = capture(registerUpdateSheetValues as (server: never) => void);

    await handler({ spreadsheet_id: 'sheet-1', range: 'Sheet1!A1', values: [['=1+1']] });

    expect(api.spreadsheets.values.update.mock.calls[0][0].valueInputOption).toBe('USER_ENTERED');
  });

  it('sends RAW when the caller asks for raw, so a formula stays text', async () => {
    api.spreadsheets.values.update.mockResolvedValue(UPDATE_OK);
    const { handler } = capture(registerUpdateSheetValues as (server: never) => void);

    await handler({
      spreadsheet_id: 'sheet-1', range: 'Sheet1!A1', values: [['=1+1']], value_input_option: 'raw',
    });

    expect(api.spreadsheets.values.update.mock.calls[0][0].valueInputOption).toBe('RAW');
  });

  it('reports what Google says it changed, not what was asked for', async () => {
    api.spreadsheets.values.update.mockResolvedValue(UPDATE_OK);
    const { handler } = capture(registerUpdateSheetValues as (server: never) => void);

    const result = await handler({ spreadsheet_id: 'sheet-1', range: 'Sheet1!A1:B2', values: ROWS });
    const payload = JSON.parse(result.content[0].text);

    expect(payload.success).toBe(true);
    expect(payload.spreadsheetId).toBe('sheet-1');
    expect(payload.updatedRange).toBe('Sheet1!A1:B2');
    expect(payload.updatedRows).toBe(2);
    expect(payload.updatedCells).toBe(4);
  });

  it('carries numbers, booleans and blanks through untouched', async () => {
    api.spreadsheets.values.update.mockResolvedValue(UPDATE_OK);
    const { handler } = capture(registerUpdateSheetValues as (server: never) => void);

    await handler({
      spreadsheet_id: 'sheet-1',
      range: 'Sheet1!A1:D1',
      values: [['text', 42, true, null]],
    });

    expect(api.spreadsheets.values.update.mock.calls[0][0].requestBody.values)
      .toEqual([['text', 42, true, null]]);
  });

  it('says plainly that it OVERWRITES, and where it can write at all', () => {
    const { description } = capture(registerUpdateSheetValues as (server: never) => void);
    expect(description).toMatch(/overwrit/i);
    expect(description).toMatch(/created/i);
  });

  it('logs the range and the size of the write — never a single cell value', async () => {
    api.spreadsheets.values.update.mockResolvedValue(UPDATE_OK);
    const { handler } = capture(registerUpdateSheetValues as (server: never) => void);

    await handler({
      spreadsheet_id: 'sheet-1',
      range: 'Sheet1!A1:B2',
      values: [['secret-value', 'another-secret']],
      account: 'work',
    });

    const entry = logCalls.find(c => c.message === 'update_sheet_values');
    expect(entry?.fields).toMatchObject({
      account: 'work',
      spreadsheet_id: 'sheet-1',
      range: 'Sheet1!A1:B2',
      rows: 1,
      cells: 2,
    });
    const serialized = JSON.stringify(logCalls);
    expect(serialized).not.toContain('secret-value');
    expect(serialized).not.toContain('another-secret');
  });

  it('is retried on a 5xx, because writing the same range twice writes it once', async () => {
    api.spreadsheets.values.update
      .mockRejectedValueOnce(Object.assign(new Error('backend error'), { code: 503 }))
      .mockResolvedValueOnce(UPDATE_OK);
    const { handler } = capture(registerUpdateSheetValues as (server: never) => void);

    const result = await handler({ spreadsheet_id: 'sheet-1', range: 'Sheet1!A1:B2', values: ROWS });

    expect(api.spreadsheets.values.update).toHaveBeenCalledTimes(2);
    expect(result.isError).toBeUndefined();
  }, 15_000);
});

// ---------------------------------------------------------------------------
// The payload ceiling — one MCP call must not occupy the server
// ---------------------------------------------------------------------------

describe('the payload ceiling is enforced before anything is sent', () => {
  function bigRows(rows: number, cols: number): unknown[][] {
    return Array.from({ length: rows }, () => Array.from({ length: cols }, () => 'x'));
  }

  it('refuses more than 10,000 cells and says how to proceed', async () => {
    const { handler } = capture(registerUpdateSheetValues as (server: never) => void);

    const result = await handler({
      spreadsheet_id: 'sheet-1', range: 'Sheet1!A1', values: bigRows(500, 21),
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/10,?000 cells/);
    expect(result.content[0].text).toMatch(/batch|smaller|several/i);
    expect(api.spreadsheets.values.update).not.toHaveBeenCalled();
  });

  it('refuses more than 1,000 rows even when the cells would fit', async () => {
    const { handler } = capture(registerUpdateSheetValues as (server: never) => void);

    const result = await handler({
      spreadsheet_id: 'sheet-1', range: 'Sheet1!A1', values: bigRows(1001, 1),
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/1,?000 rows/);
    expect(api.spreadsheets.values.update).not.toHaveBeenCalled();
  });

  it('allows exactly the ceiling — the limit is not off by one', async () => {
    api.spreadsheets.values.update.mockResolvedValue(UPDATE_OK);
    const { handler } = capture(registerUpdateSheetValues as (server: never) => void);

    const result = await handler({
      spreadsheet_id: 'sheet-1', range: 'Sheet1!A1', values: bigRows(1000, 10),
    });

    expect(result.isError).toBeUndefined();
    expect(api.spreadsheets.values.update).toHaveBeenCalledTimes(1);
  });

  it('refuses a call with no rows rather than reporting a success that changed nothing', async () => {
    const { handler } = capture(registerUpdateSheetValues as (server: never) => void);

    const result = await handler({ spreadsheet_id: 'sheet-1', range: 'Sheet1!A1', values: [] });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/nothing|no rows|at least one/i);
    expect(api.spreadsheets.values.update).not.toHaveBeenCalled();
  });

  it('refuses a blank range instead of letting Google guess', async () => {
    const { handler } = capture(registerUpdateSheetValues as (server: never) => void);

    const result = await handler({ spreadsheet_id: 'sheet-1', range: '   ', values: ROWS });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/range/i);
    expect(api.spreadsheets.values.update).not.toHaveBeenCalled();
  });

  it('refuses a blank spreadsheet id', async () => {
    const { handler } = capture(registerUpdateSheetValues as (server: never) => void);

    const result = await handler({ spreadsheet_id: '  ', range: 'Sheet1!A1', values: ROWS });

    expect(result.isError).toBe(true);
    expect(api.spreadsheets.values.update).not.toHaveBeenCalled();
  });

  it('guards append with the same ceiling', async () => {
    const { handler } = capture(registerAppendSheetRows as (server: never) => void);

    const result = await handler({
      spreadsheet_id: 'sheet-1', range: 'Sheet1', values: bigRows(1001, 1),
    });

    expect(result.isError).toBe(true);
    expect(api.spreadsheets.values.append).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// append_sheet_rows
// ---------------------------------------------------------------------------

describe('append_sheet_rows', () => {
  it('appends at the table anchor and reads the result out of updates', async () => {
    api.spreadsheets.values.append.mockResolvedValue(APPEND_OK);
    const { handler } = capture(registerAppendSheetRows as (server: never) => void);

    const result = await handler({ spreadsheet_id: 'sheet-1', range: 'Sheet1', values: ROWS });
    const payload = JSON.parse(result.content[0].text);

    const args = api.spreadsheets.values.append.mock.calls[0][0];
    expect(args.spreadsheetId).toBe('sheet-1');
    expect(args.range).toBe('Sheet1');
    expect(args.requestBody.values).toEqual(ROWS);

    expect(payload.success).toBe(true);
    expect(payload.updatedRange).toBe('Sheet1!A4:B5');
    expect(payload.updatedRows).toBe(2);
    expect(payload.updatedCells).toBe(4);
  });

  it('inserts rows rather than writing over whatever sits below the table', async () => {
    // OVERWRITE — Google's default — writes into the cells after the table
    // whether or not something is already in them. This server creates rather
    // than destroys everywhere else; appending is no exception.
    api.spreadsheets.values.append.mockResolvedValue(APPEND_OK);
    const { handler } = capture(registerAppendSheetRows as (server: never) => void);

    await handler({ spreadsheet_id: 'sheet-1', range: 'Sheet1', values: ROWS });

    expect(api.spreadsheets.values.append.mock.calls[0][0].insertDataOption).toBe('INSERT_ROWS');
  });

  it('reports the table it appended to, so the caller can see where the rows went', async () => {
    api.spreadsheets.values.append.mockResolvedValue(APPEND_OK);
    const { handler } = capture(registerAppendSheetRows as (server: never) => void);

    const payload = JSON.parse(
      (await handler({ spreadsheet_id: 'sheet-1', range: 'Sheet1', values: ROWS })).content[0].text,
    );

    expect(payload.tableRange).toBe('Sheet1!A1:B3');
  });

  it('defaults to user_entered and honours raw, like the update tool', async () => {
    api.spreadsheets.values.append.mockResolvedValue(APPEND_OK);
    const { handler } = capture(registerAppendSheetRows as (server: never) => void);

    await handler({ spreadsheet_id: 'sheet-1', range: 'Sheet1', values: ROWS });
    expect(api.spreadsheets.values.append.mock.calls[0][0].valueInputOption).toBe('USER_ENTERED');

    await handler({
      spreadsheet_id: 'sheet-1', range: 'Sheet1', values: ROWS, value_input_option: 'raw',
    });
    expect(api.spreadsheets.values.append.mock.calls[1][0].valueInputOption).toBe('RAW');
  });

  it('is NOT retried on a 5xx — a retried append writes the rows twice', async () => {
    // The trade googleApiCall documents for post_chat_message and
    // create_google_doc: a gateway timeout can arrive after the write landed.
    // For an append that means duplicate rows nobody asked for, so the failure
    // is reported instead of guessed at.
    api.spreadsheets.values.append.mockRejectedValue(
      Object.assign(new Error('backend error'), { code: 503 }),
    );
    const { handler } = capture(registerAppendSheetRows as (server: never) => void);

    const result = await handler({ spreadsheet_id: 'sheet-1', range: 'Sheet1', values: ROWS });

    expect(result.isError).toBe(true);
    expect(api.spreadsheets.values.append).toHaveBeenCalledTimes(1);
  });

  it('logs the size of the append and no cell values', async () => {
    api.spreadsheets.values.append.mockResolvedValue(APPEND_OK);
    const { handler } = capture(registerAppendSheetRows as (server: never) => void);

    await handler({
      spreadsheet_id: 'sheet-1', range: 'Sheet1', values: [['confidential-row']], account: 'work',
    });

    const entry = logCalls.find(c => c.message === 'append_sheet_rows');
    expect(entry?.fields).toMatchObject({
      account: 'work', spreadsheet_id: 'sheet-1', range: 'Sheet1', rows: 1, cells: 1,
    });
    expect(JSON.stringify(logCalls)).not.toContain('confidential-row');
  });

  it('says in its description that it adds rows without overwriting', () => {
    const { description } = capture(registerAppendSheetRows as (server: never) => void);
    expect(description).toMatch(/append|add/i);
    expect(description).toMatch(/created/i);
  });
});

// ---------------------------------------------------------------------------
// Honest failures. The interesting one is unique to this design: a spreadsheet
// the server did not create is INVISIBLE under drive.file, and Google says so
// with the same 404 it uses for a file that never existed.
// ---------------------------------------------------------------------------

describe('a spreadsheet this server did not create', () => {
  const cases = [
    {
      label: 'update_sheet_values',
      register: registerUpdateSheetValues,
      mock: api.spreadsheets.values.update,
      args: { spreadsheet_id: 'someone-elses', range: 'Sheet1!A1', values: ROWS },
    },
    {
      label: 'append_sheet_rows',
      register: registerAppendSheetRows,
      mock: api.spreadsheets.values.append,
      args: { spreadsheet_id: 'someone-elses', range: 'Sheet1', values: ROWS },
    },
  ] as const;

  describe.each(cases)('$label', ({ register, mock, args }) => {
    it('explains the drive.file boundary in plain words on a 404', async () => {
      mock.mockRejectedValue(googleError(404, 'notFound', 'Requested entity was not found.'));
      const { handler } = capture(register as (server: never) => void);

      const text = (await handler(args)).content[0].text;

      expect(text).toMatch(/created/i);
      expect(text).toContain('drive.file');
      expect(text).toContain('someone-elses');
    });

    it('points at the cure — re-upload it with convert so this server owns a copy', async () => {
      mock.mockRejectedValue(googleError(404, 'notFound', 'Requested entity was not found.'));
      const { handler } = capture(register as (server: never) => void);

      const text = (await handler(args)).content[0].text;

      expect(text).toContain('upload_drive_file');
      expect(text).toMatch(/convert/i);
    });

    it('does not send the reader off to re-authenticate, which cannot help', async () => {
      mock.mockRejectedValue(googleError(404, 'notFound', 'Requested entity was not found.'));
      const { handler } = capture(register as (server: never) => void);

      const text = (await handler(args)).content[0].text;

      expect(text).not.toMatch(/Re-authenticate with: npx tsx/);
      expect(text).not.toMatch(/npm run auth/);
    });

    it('says the same about a plain 403 on a file it cannot reach', async () => {
      mock.mockRejectedValue(googleError(
        403, 'insufficientFilePermissions', 'The caller does not have permission.',
      ));
      const { handler } = capture(register as (server: never) => void);

      const text = (await handler(args)).content[0].text;

      expect(text).toMatch(/created/i);
      expect(text).toContain('The caller does not have permission.');
    });
  });
});

describe('the other failures keep the shared honest wording', () => {
  const API_DISABLED =
    'Google Sheets API has not been used in project 12345 before or it is disabled. '
    + 'Enable it by visiting https://console.developers.google.com/apis/api/x/overview?project=12345 then retry.';

  it('a disabled Sheets API says to enable it in the console, and names Google Sheets', async () => {
    api.spreadsheets.values.update.mockRejectedValue(
      googleError(403, 'accessNotConfigured', API_DISABLED),
    );
    const { handler } = capture(registerUpdateSheetValues as (server: never) => void);

    const text = (await handler({
      spreadsheet_id: 'sheet-1', range: 'Sheet1!A1', values: ROWS, account: 'work',
    })).content[0].text;

    expect(text).toContain('Google Sheets API is not enabled');
    expect(text).toContain('console.developers.google.com');
    expect(text).toMatch(/will not help/);
  });

  it('a missing scope still names drive.file and the re-consent command', async () => {
    api.spreadsheets.values.update.mockRejectedValue(
      Object.assign(new Error('Request had insufficient authentication scopes.'), {
        code: 403,
        errors: [{ reason: 'insufficientPermissions' }],
        response: { status: 403, data: { error: { errors: [{ reason: 'insufficientPermissions' }] } } },
      }),
    );
    const { handler } = capture(registerUpdateSheetValues as (server: never) => void);

    const text = (await handler({
      spreadsheet_id: 'sheet-1', range: 'Sheet1!A1', values: ROWS, account: 'work',
    })).content[0].text;

    expect(text).toContain('drive.file');
    expect(text).toContain('npm run auth -- work');
  });

  it('a 401 is left to the shared re-authenticate path, where re-login IS the fix', async () => {
    api.spreadsheets.values.update.mockRejectedValue(
      googleError(401, 'authError', 'Invalid Credentials'),
    );
    const { handler } = capture(registerUpdateSheetValues as (server: never) => void);

    const text = (await handler({
      spreadsheet_id: 'sheet-1', range: 'Sheet1!A1', values: ROWS,
    })).content[0].text;

    expect(text).toMatch(/Authentication error \(401\)/);
  });

  it('a failed write is logged as failed, with no cell values in the record', async () => {
    api.spreadsheets.values.update.mockRejectedValue(
      googleError(404, 'notFound', 'Requested entity was not found.'),
    );
    const { handler } = capture(registerUpdateSheetValues as (server: never) => void);

    await handler({ spreadsheet_id: 'sheet-1', range: 'Sheet1!A1', values: [['secret-cell']] });

    const failed = logCalls.find(c => c.level === 'error' && c.message === 'update_sheet_values');
    expect(failed).toBeDefined();
    expect(JSON.stringify(logCalls)).not.toContain('secret-cell');
  });
});
