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

export const includeQuoteParam = z
  .boolean()
  .optional()
  .describe('Include the quoted original below your reply, as Gmail does (default: true).');

export const includeAttachmentsParam = z
  .boolean()
  .optional()
  .describe("Re-attach the original message's attachments (default: true).");
