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

// ---------------------------------------------------------------------------
// Google Workspace administration (2026-09-02). These tools act on a company's
// DIRECTORY rather than on a mailbox, so their shared parameters carry more
// warning than most.
// ---------------------------------------------------------------------------

/**
 * `account` on an admin tool, and it is REQUIRED — the one parameter in this
 * server that has no default.
 *
 * Everywhere else an omitted account falls back to the one named in
 * accounts.json, and that account is an ordinary mailbox. A directory call
 * landing there by default would be a change made to the wrong company, so the
 * schema refuses the omission rather than guessing.
 */
export const adminAccountParam = z
  .string()
  .describe(
    'REQUIRED. The alias (or email) of the account that administers the Google Workspace you '
    + 'mean — there is no default here, unlike the mail tools. The account must be marked '
    + '"workspace_admin": true in accounts.json, and must have signed in since the admin '
    + 'permissions were added.',
  );

/**
 * The group settings this server will read or write. Allow-listed on purpose:
 * the Groups Settings API carries dozens of fields, most about the Google
 * Groups web forum rather than about mail.
 *
 * Kept in step with `GROUP_SETTING_FIELDS` in src/workspace-admin/client.ts by
 * a test that compares the two — that table is where the conversion lives, and
 * two lists that disagreed would mean a setting a caller can pass and the
 * server cannot send.
 *
 * Booleans are real booleans here. Google carries them as the strings "true"
 * and "false"; the conversion happens on the way out and back, so nobody
 * calling these tools has to know that.
 */
export const groupSettingsSchema = z.object({
  who_can_post_message: z.enum([
    'NONE_CAN_POST', 'ALL_MANAGERS_CAN_POST', 'ALL_MEMBERS_CAN_POST',
    'ALL_OWNERS_CAN_POST', 'ALL_IN_DOMAIN_CAN_POST', 'ANYONE_CAN_POST',
  ]).optional(),
  allow_external_members: z.boolean().optional(),
  who_can_view_group: z.enum([
    'ANYONE_CAN_VIEW', 'ALL_IN_DOMAIN_CAN_VIEW', 'ALL_MEMBERS_CAN_VIEW',
    'ALL_MANAGERS_CAN_VIEW', 'ALL_OWNERS_CAN_VIEW',
  ]).optional(),
  who_can_view_membership: z.enum([
    'ALL_IN_DOMAIN_CAN_VIEW', 'ALL_MEMBERS_CAN_VIEW', 'ALL_MANAGERS_CAN_VIEW',
  ]).optional(),
  who_can_join: z.enum([
    'ANYONE_CAN_JOIN', 'ALL_IN_DOMAIN_CAN_JOIN', 'INVITED_CAN_JOIN', 'CAN_REQUEST_TO_JOIN',
  ]).optional(),
  who_can_discover_group: z.enum([
    'ANYONE_CAN_DISCOVER', 'ALL_IN_DOMAIN_CAN_DISCOVER', 'ALL_MEMBERS_CAN_DISCOVER',
  ]).optional(),
  who_can_contact_owner: z.enum([
    'ALL_IN_DOMAIN_CAN_CONTACT', 'ALL_MANAGERS_CAN_CONTACT',
    'ALL_MEMBERS_CAN_CONTACT', 'ANYONE_CAN_CONTACT',
  ]).optional(),
  message_moderation_level: z.enum([
    'MODERATE_ALL_MESSAGES', 'MODERATE_NON_MEMBERS', 'MODERATE_NEW_MEMBERS', 'MODERATE_NONE',
  ]).optional(),
  spam_moderation_level: z.enum(['ALLOW', 'MODERATE', 'SILENTLY_MODERATE', 'REJECT']).optional(),
  reply_to: z.enum([
    'REPLY_TO_CUSTOM', 'REPLY_TO_SENDER', 'REPLY_TO_LIST',
    'REPLY_TO_OWNER', 'REPLY_TO_IGNORE', 'REPLY_TO_MANAGERS',
  ]).optional(),
  custom_reply_to: z.string().optional(),
  include_in_global_address_list: z.boolean().optional(),
  allow_web_posting: z.boolean().optional(),
  is_archived: z.boolean().optional(),
  enable_collaborative_inbox: z.boolean().optional(),
  members_can_post_as_the_group: z.boolean().optional(),
  who_can_leave_group: z.enum([
    'ALL_MANAGERS_CAN_LEAVE', 'ALL_MEMBERS_CAN_LEAVE', 'NONE_CAN_LEAVE',
  ]).optional(),
  name: z.string().optional(),
  description: z.string().optional(),
});

/**
 * The recipe for "this address accepts mail from outside the company" is
 * spelled out in words here because it is the reason these tools exist, and it
 * is four settings rather than one. It is stated as guidance, NOT applied as a
 * default: the tools send exactly what they are given and nothing else.
 */
export const GROUP_SETTINGS_DESCRIPTION =
  'Group settings, using real true/false for the switches. To make an address ACCEPT MAIL FROM '
  + 'OUTSIDE the company — a persona address that forwards into a CRM, say — you need four of '
  + 'them together: who_can_post_message "ANYONE_CAN_POST", allow_external_members true, and '
  + 'usually spam_moderation_level "ALLOW" and message_moderation_level "MODERATE_NONE" so '
  + 'forwarded mail is delivered rather than held for a moderator nobody is watching. Only the '
  + 'keys you pass are sent; nothing else about the group is changed, and none of the four is '
  + 'applied unless you ask for it.';
