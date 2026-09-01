import { z } from 'zod';

/**
 * Descriptions shared by every composing tool.
 *
 * The body wording is load-bearing, not decoration. Composing models were
 * hard-wrapping prose at ~70 columns and the server transmitted those newlines
 * verbatim into a text/plain part, which Gmail renders as literal line breaks —
 * the "narrow paragraphs" symptom. The old description ("Email body content")
 * gave no signal that a newline was load-bearing. This one does.
 */
export const BODY_DESCRIPTION =
  'Email body. Write it as you would type it in Gmail: full paragraphs on a SINGLE '
  + 'line each — do NOT hard-wrap or insert manual line breaks at ~70-80 characters. '
  + "Every newline you write becomes a visible line break in the recipient's inbox. "
  + 'Use a blank line between paragraphs. The server renders this to Gmail-native '
  + 'HTML plus a plain-text alternative automatically.';

export const IS_HTML_DESCRIPTION =
  'Set true only when body is already HTML markup. Leave unset for normal writing — '
  + 'plain text is converted to Gmail-native HTML automatically, so HTML is NOT '
  + 'needed for formatting.';

export const GMAIL_NATIVE_CLAUSE =
  'Sends Gmail-native mail (multipart HTML + plain text, signature, quoted history) '
  + 'indistinguishable from mail composed in Gmail.';

export const includeSignatureParam = z
  .boolean()
  .optional()
  .describe("Append the account's Gmail signature (default: true).");

export const attachmentsParam = z
  .array(z.string())
  .optional()
  .describe('Absolute file paths to attach. 25MB total.');

/**
 * The cid convention is stated in full here because it is the only way a model
 * can write a working `<img>` tag on the first try: the reference is the file's
 * own name, not a server-minted identifier it would have to be told.
 */
export const inlineImagesParam = z
  .array(z.string())
  .optional()
  .describe(
    'Absolute file paths of images to embed IN the body rather than attach. Reference each '
    + 'one from the HTML as <img src="cid:FILENAME"> where FILENAME is the file\'s name with '
    + 'its extension — /home/me/logo.png is cid:logo.png. Characters outside letters, digits, '
    + 'dot, dash and underscore become underscores, so prefer simple filenames, and no two '
    + 'images may share a name. Requires is_html: true and is REFUSED without it — a cid: '
    + 'reference means nothing in a plain-text body. Counts against the same 25MB total as '
    + 'attachments.',
  );

export const includeQuoteParam = z
  .boolean()
  .optional()
  .describe('Include the quoted original below your reply, as Gmail does (default: true).');

export const includeAttachmentsParam = z
  .boolean()
  .optional()
  .describe("Re-attach the original message's attachments (default: true).");

// ---------------------------------------------------------------------------
// Sheets writes (2026-09-01). update_sheet_values and append_sheet_rows differ
// only in what they do with the range, so everything else is stated once here.
// ---------------------------------------------------------------------------

/**
 * What a cell may be. `null` writes a blank rather than deleting the cell,
 * which is what "leave this one empty" has to mean in a fixed-width row.
 */
export const sheetCellSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const spreadsheetIdParam = z
  .string()
  .describe(
    'The Google Sheets spreadsheet id. This server can only write to spreadsheets it created '
    + 'itself — typically one that upload_drive_file put there with convert:true.',
  );

export const sheetValuesParam = z
  .array(z.array(sheetCellSchema))
  .describe(
    'The rows to write: outer array = rows, inner = cells across. Strings, numbers, booleans '
    + 'and null (a blank cell) are all allowed. Up to 1,000 rows and 10,000 cells per call; '
    + 'send more than that as several calls.',
  );

export const valueInputOptionParam = z
  .enum(['raw', 'user_entered'])
  .optional()
  .describe(
    'How Google should read what you send. "user_entered" (the default) behaves as if a person '
    + 'typed it, so "=SUM(A1:A2)" becomes a formula and "5%" becomes a percentage. "raw" stores '
    + 'every value literally as text or a number, formulas included.',
  );
