/**
 * Mail rules and the vacation responder — `users.settings.filters.*` and
 * `users.settings.{get,update}Vacation`.
 *
 * This module is deliberately separate from `settings.ts`. That one exists to
 * fetch a signature without ever failing a send: it swallows its own errors and
 * needs no scope beyond what composition already has. Everything here is the
 * opposite contract — these are user-invoked tools that MUST fail loudly, and
 * every one of them needs `gmail.settings.basic`, a scope added on 2026-08-27
 * that no token issued before then carries. Until an alias re-consents
 * (`npm run auth -- <alias>`) every function in this file answers 403, and
 * `withScopeHint` turns that into an instruction rather than a puzzle.
 *
 * Two deliberate omissions, both about not building a quiet exfiltration path:
 *
 * 1. `create_filter` cannot set a FORWARDING action. Gmail filters can forward
 *    matching mail to another address; a tool that can create one can quietly
 *    route a mailbox off-site. Forwarding also needs a separately verified
 *    address and a wider scope, so leaving it out costs nothing real. Existing
 *    forwarding filters are still REPORTED by `list_filters` — the read side
 *    tells the truth about what is configured.
 * 2. Nothing here deletes or rewrites mail directly. A filter that adds the
 *    TRASH label does, which is why the tool description says so plainly.
 */
import type { gmail_v1 } from 'googleapis';
import { type AccountConfig, resolveAccount } from '../config.js';
import { getGmailClient, withRetry } from './client.js';
import { htmlToText, textToHtml } from './mime.js';
import { log } from '../log.js';
import { withScopeHint } from '../scope-error.js';

/** The scope every call in this module needs. Quoted in the error messages. */
export const GMAIL_SETTINGS_SCOPE = 'https://www.googleapis.com/auth/gmail.settings.basic';

/** Resolve an account input to its config record (string alias/email or object). */
function resolve(account?: string | AccountConfig): AccountConfig {
  return typeof account === 'string' || account === undefined
    ? resolveAccount(account)
    : account;
}

// ---------------------------------------------------------------------------
// Filters (mail rules)
// ---------------------------------------------------------------------------

export interface FilterCriteria {
  from?: string;
  to?: string;
  subject?: string;
  query?: string;
  negatedQuery?: string;
  hasAttachment?: boolean;
  excludeChats?: boolean;
  /**
   * Read-only, both of them. Gmail lets a filter match on message size; this
   * server does not create such a filter, but reporting one as `criteria: {}`
   * would describe it as matching every message in the mailbox — the exact
   * thing `create_filter` refuses to build.
   */
  size?: number;
  /** `larger` or `smaller`, as Gmail returns it. */
  sizeComparison?: string;
}

export interface FilterSummary {
  id: string;
  criteria: FilterCriteria;
  addLabelIds: string[];
  removeLabelIds: string[];
  /** Present only when the EXISTING filter forwards; this server never sets it. */
  forward?: string;
}

export interface CreateFilterOptions {
  criteria: FilterCriteria;
  addLabelIds?: string[];
  removeLabelIds?: string[];
  account?: string | AccountConfig;
}

function toFilterSummary(filter: gmail_v1.Schema$Filter): FilterSummary {
  const criteria = filter.criteria ?? {};
  const action = filter.action ?? {};
  return {
    id: filter.id ?? '',
    criteria: {
      ...(criteria.from ? { from: criteria.from } : {}),
      ...(criteria.to ? { to: criteria.to } : {}),
      ...(criteria.subject ? { subject: criteria.subject } : {}),
      ...(criteria.query ? { query: criteria.query } : {}),
      ...(criteria.negatedQuery ? { negatedQuery: criteria.negatedQuery } : {}),
      ...(criteria.hasAttachment ? { hasAttachment: true } : {}),
      ...(criteria.excludeChats ? { excludeChats: true } : {}),
      ...(typeof criteria.size === 'number' ? { size: criteria.size } : {}),
      ...(criteria.sizeComparison ? { sizeComparison: criteria.sizeComparison } : {}),
    },
    addLabelIds: action.addLabelIds ?? [],
    removeLabelIds: action.removeLabelIds ?? [],
    ...(action.forward ? { forward: action.forward } : {}),
  };
}

/** Clean a criteria value: trim, and drop it entirely when it is blank. */
function text(value: string | undefined): string | undefined {
  const trimmed = (value ?? '').trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Clean a label id list: trim each, drop blanks, dedupe, preserve order. */
function labelIds(values: string[] | undefined): string[] {
  const out: string[] = [];
  for (const value of values ?? []) {
    const trimmed = value.trim();
    if (trimmed.length > 0 && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

/**
 * List the account's filters (mail rules), newest-API-order as returned.
 */
export async function listFilters(
  account?: string | AccountConfig,
): Promise<{ filters: FilterSummary[]; account: string }> {
  const resolved = resolve(account);
  const gmail = await getGmailClient(resolved);

  const response = await withScopeHint(
    { tool: 'list_filters', scope: GMAIL_SETTINGS_SCOPE, alias: resolved.alias },
    () => withRetry(() => gmail.users.settings.filters.list({ userId: 'me' })),
  );

  return {
    filters: (response.data.filter ?? []).map(toFilterSummary),
    account: resolved.alias,
  };
}

/**
 * Create a filter. Requires at least one criterion AND at least one label
 * action: a filter with no criteria would match every message, and one with no
 * action would do nothing — both are caller mistakes rather than requests, and
 * this server already refuses no-op modify calls elsewhere for the same reason.
 */
export async function createFilter(opts: CreateFilterOptions): Promise<FilterSummary & { account: string }> {
  const resolved = resolve(opts.account);

  const criteria: FilterCriteria = {
    ...(text(opts.criteria?.from) ? { from: text(opts.criteria.from) as string } : {}),
    ...(text(opts.criteria?.to) ? { to: text(opts.criteria.to) as string } : {}),
    ...(text(opts.criteria?.subject) ? { subject: text(opts.criteria.subject) as string } : {}),
    ...(text(opts.criteria?.query) ? { query: text(opts.criteria.query) as string } : {}),
    ...(text(opts.criteria?.negatedQuery) ? { negatedQuery: text(opts.criteria.negatedQuery) as string } : {}),
    ...(opts.criteria?.hasAttachment ? { hasAttachment: true } : {}),
    ...(opts.criteria?.excludeChats ? { excludeChats: true } : {}),
  };

  if (Object.keys(criteria).length === 0) {
    throw new Error(
      'create_filter: at least one criterion is required (from, to, subject, query, '
      + 'negated_query, has_attachment or exclude_chats). A filter with no criteria would '
      + 'match every message in the mailbox.',
    );
  }

  const addLabelIds = labelIds(opts.addLabelIds);
  const removeLabelIds = labelIds(opts.removeLabelIds);
  if (addLabelIds.length === 0 && removeLabelIds.length === 0) {
    throw new Error(
      'create_filter: at least one of add_label_ids or remove_label_ids is required — '
      + 'a filter with no action does nothing.',
    );
  }

  const gmail = await getGmailClient(resolved);
  const response = await withScopeHint(
    { tool: 'create_filter', scope: GMAIL_SETTINGS_SCOPE, alias: resolved.alias },
    () => withRetry(() =>
      gmail.users.settings.filters.create({
        userId: 'me',
        requestBody: {
          criteria,
          action: {
            ...(addLabelIds.length > 0 ? { addLabelIds } : {}),
            ...(removeLabelIds.length > 0 ? { removeLabelIds } : {}),
          },
        },
      }),
    ),
  );

  const summary = toFilterSummary(response.data);

  // Mutating path: logged like every other one. Ids and counts only — never the
  // criteria, which can carry an address or a subject line.
  log('info', 'create_filter', {
    account: resolved.alias,
    filter_id: summary.id || null,
    criteria_fields: Object.keys(criteria),
    add_label_count: addLabelIds.length,
    remove_label_count: removeLabelIds.length,
  });

  return { ...summary, account: resolved.alias };
}

/**
 * Delete a filter permanently. Deleting a filter does not touch any mail it
 * previously acted on.
 */
export async function deleteFilter(
  filterId: string,
  account?: string | AccountConfig,
): Promise<{ id: string; account: string }> {
  const id = (filterId ?? '').trim();
  if (!id) throw new Error('delete_filter: filter_id is required');

  const resolved = resolve(account);
  const gmail = await getGmailClient(resolved);

  log('info', 'delete_filter', { account: resolved.alias, filter_id: id });

  await withScopeHint(
    { tool: 'delete_filter', scope: GMAIL_SETTINGS_SCOPE, alias: resolved.alias },
    () => withRetry(() => gmail.users.settings.filters.delete({ userId: 'me', id })),
  );

  return { id, account: resolved.alias };
}

// ---------------------------------------------------------------------------
// Vacation responder
// ---------------------------------------------------------------------------

export interface VacationState {
  enabled: boolean;
  responseSubject: string;
  responseBodyPlainText: string;
  responseBodyHtml: string;
  restrictToContacts: boolean;
  restrictToDomain: boolean;
  /** ISO 8601, when Gmail has a start/end set. */
  startTime?: string;
  endTime?: string;
  account: string;
}

export interface SetVacationOptions {
  enable: boolean;
  subject?: string;
  body?: string;
  isHtml?: boolean;
  startTime?: string;
  endTime?: string;
  restrictToContacts?: boolean;
  restrictToDomain?: boolean;
  account?: string | AccountConfig;
}

/** Gmail carries these as milliseconds-since-epoch strings. */
function toIso(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  return new Date(ms).toISOString();
}

function toEpochMs(value: string, field: 'start_time' | 'end_time'): string {
  const trimmed = value.trim();
  const ms = Date.parse(trimmed);
  if (Number.isNaN(ms)) {
    throw new Error(
      `set_vacation: ${field} "${trimmed}" is not a valid ISO 8601 date or timestamp`,
    );
  }
  return String(ms);
}

function toVacationState(
  settings: gmail_v1.Schema$VacationSettings,
  alias: string,
): VacationState {
  return {
    enabled: settings.enableAutoReply === true,
    responseSubject: settings.responseSubject ?? '',
    responseBodyPlainText: settings.responseBodyPlainText ?? '',
    responseBodyHtml: settings.responseBodyHtml ?? '',
    restrictToContacts: settings.restrictToContacts === true,
    restrictToDomain: settings.restrictToDomain === true,
    ...(toIso(settings.startTime) ? { startTime: toIso(settings.startTime) as string } : {}),
    ...(toIso(settings.endTime) ? { endTime: toIso(settings.endTime) as string } : {}),
    account: alias,
  };
}

/** Read the current vacation-responder settings. */
export async function getVacation(
  account?: string | AccountConfig,
): Promise<VacationState> {
  const resolved = resolve(account);
  const gmail = await getGmailClient(resolved);

  const response = await withScopeHint(
    { tool: 'get_vacation', scope: GMAIL_SETTINGS_SCOPE, alias: resolved.alias },
    () => withRetry(() => gmail.users.settings.getVacation({ userId: 'me' })),
  );

  return toVacationState(response.data, resolved.alias);
}

/**
 * Turn the vacation responder on or off.
 *
 * `updateVacation` REPLACES the whole settings object, so this reads the
 * current settings first and merges the supplied fields over them — the same
 * fetch-and-preserve rule the label tools already follow. Without it, "turn the
 * responder off" would also erase the message the user wrote, and "change the
 * subject" would blank the body.
 *
 * Enabling this is an OUTWARD act: while it is on, Gmail replies automatically,
 * from this account, to people who write in. Nothing else in this server sends
 * mail without an explicit call, which is why the result carries a notice
 * saying plainly what is now switched on.
 */
export async function setVacation(opts: SetVacationOptions): Promise<VacationState & { notice: string }> {
  const resolved = resolve(opts.account);
  const gmail = await getGmailClient(resolved);
  const ctx = { tool: 'set_vacation', scope: GMAIL_SETTINGS_SCOPE, alias: resolved.alias };

  const currentResp = await withScopeHint(ctx, () =>
    withRetry(() => gmail.users.settings.getVacation({ userId: 'me' })),
  );
  const current = currentResp.data ?? {};

  const isHtml = opts.isHtml === true;

  // Omitting body means "keep what is saved". Passing a BLANK one meant the
  // same thing, silently: a caller clearing the auto-reply got success back
  // and the old message stayed live. There is no way to store an empty
  // responder either — enabling one is refused below, and an empty message is
  // worse than none — so this is a caller mistake with two honest readings and
  // no safe guess between them.
  if (opts.body !== undefined && opts.body.trim() === '') {
    throw new Error(
      'set_vacation: body was supplied but is empty. Omit body to keep the saved message, '
      + 'or pass the text you want the responder to send. An empty automatic reply cannot '
      + 'be stored.',
    );
  }
  const body = opts.body;

  const merged: gmail_v1.Schema$VacationSettings = {
    ...current,
    enableAutoReply: opts.enable,
    ...(opts.subject !== undefined ? { responseSubject: opts.subject } : {}),
    // BOTH flavours, or neither. Gmail's VacationSettings carries a plain-text
    // and an HTML body and PREFERS the HTML one when both are set, so writing
    // only the flavour the caller named left the other one saying something
    // else: changing an HTML responder's text with a plain `body` reported
    // success, echoed the new text, and the account went on sending the old
    // one. Fetch-and-preserve is right for the subject and the window; for the
    // body it is the bug. The unnamed flavour is derived from the supplied one
    // by the same converters the composer uses, so the two cannot disagree.
    ...(body !== undefined
      ? isHtml
        ? { responseBodyHtml: body, responseBodyPlainText: htmlToText(body) }
        : { responseBodyPlainText: body, responseBodyHtml: textToHtml(body) }
      : {}),
    ...(opts.restrictToContacts !== undefined ? { restrictToContacts: opts.restrictToContacts } : {}),
    ...(opts.restrictToDomain !== undefined ? { restrictToDomain: opts.restrictToDomain } : {}),
    ...(opts.startTime !== undefined ? { startTime: toEpochMs(opts.startTime, 'start_time') } : {}),
    ...(opts.endTime !== undefined ? { endTime: toEpochMs(opts.endTime, 'end_time') } : {}),
  };

  if (opts.enable) {
    const hasBody = !!(merged.responseBodyPlainText?.trim() || merged.responseBodyHtml?.trim());
    if (!hasBody) {
      throw new Error(
        'set_vacation: a response body is required to enable the vacation responder — '
        + 'the account has no saved auto-reply text, and an empty automatic reply is worse '
        + 'than none. Pass body.',
      );
    }
    const start = Number(merged.startTime ?? 0);
    const end = Number(merged.endTime ?? 0);
    if (start > 0 && end > 0 && end <= start) {
      throw new Error(
        `set_vacation: end_time "${opts.endTime ?? toIso(merged.endTime)}" must be after `
        + `start_time "${opts.startTime ?? toIso(merged.startTime)}"`,
      );
    }
  }

  // Logged BEFORE the call, like the other outward paths: this is the point at
  // which the account may start replying to strangers on its own. Flags only —
  // never the auto-reply text.
  log('info', 'set_vacation', {
    account: resolved.alias,
    enable: opts.enable,
    restrict_to_contacts: merged.restrictToContacts === true,
    restrict_to_domain: merged.restrictToDomain === true,
    has_window: !!(merged.startTime || merged.endTime),
  });

  const response = await withScopeHint(ctx, () =>
    withRetry(() => gmail.users.settings.updateVacation({ userId: 'me', requestBody: merged })),
  );

  const state = toVacationState(response.data ?? merged, resolved.alias);
  const notice = state.enabled
    ? 'The vacation responder is ON: Gmail will now reply automatically, from this account, '
      + 'to incoming mail'
      + (state.restrictToContacts ? ' from your contacts only' : '')
      + (state.startTime || state.endTime ? ', within the configured window' : '')
      + '.'
    : 'The vacation responder is OFF. The saved subject and message were kept, so turning it '
      + 'back on does not need them again.';

  return { ...state, notice };
}
