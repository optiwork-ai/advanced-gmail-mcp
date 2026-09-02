import { google } from 'googleapis';
import type { Auth, admin_directory_v1, groupssettings_v1 } from 'googleapis';
import { type AccountConfig, getAccounts, resolveAccount } from '../config.js';
import { getAuthClient } from '../gmail/auth.js';
import { isRateLimit403 } from '../gmail/client.js';
import { googleApiCall } from '../google-api-error.js';
import { errorStatus, googleErrorMessage, googleErrorReasons, isMissingScopeError } from '../scope-error.js';

/**
 * The Google Workspace admin client — Admin SDK Directory plus Groups Settings.
 *
 * Added 2026-09-02 for one concrete job: creating and configuring the Google
 * Groups that persona addresses live on, including the part no mailbox setting
 * can express — whether an address accepts mail from outside the company.
 *
 * Two things make this module different from every other client here, and both
 * are refusals:
 *
 *  - `account` is REQUIRED on every admin tool. Everywhere else in this server
 *    an omitted account falls back to the default, and the default here is a
 *    consumer Gmail mailbox. A directory call landing there by default would be
 *    a call made against the wrong company with nobody told, so the fallback is
 *    removed rather than warned about.
 *  - the `workspace_admin` flag is checked BEFORE a token is read or a client
 *    is built, so an account that should never make an admin call fails
 *    locally, in words, instead of arriving at Google as a 403.
 *
 * Everything else follows the shape src/sheets/client.ts and src/docs/client.ts
 * already use: a per-account cache with a 50-minute TTL, exported scope
 * constants so each call's error can name the scope IT needs, and honest
 * failures layered on top of the shared translator rather than replacing it.
 */

// ---------------------------------------------------------------------------
// Scopes and API names
// ---------------------------------------------------------------------------

/**
 * Directory user operations — and, because Google folds them in, user ALIAS
 * operations too. There is no separate alias scope to ask for.
 */
export const ADMIN_DIRECTORY_USER_SCOPE = 'https://www.googleapis.com/auth/admin.directory.user';

/** Group operations, group aliases included, for the same reason. */
export const ADMIN_DIRECTORY_GROUP_SCOPE = 'https://www.googleapis.com/auth/admin.directory.group';

/** Adding and removing members of a group. */
export const ADMIN_DIRECTORY_GROUP_MEMBER_SCOPE =
  'https://www.googleapis.com/auth/admin.directory.group.member';

/** Reading the Workspace's domains — which is how "whose Workspace is this?" gets answered. */
export const ADMIN_DIRECTORY_DOMAIN_SCOPE = 'https://www.googleapis.com/auth/admin.directory.domain';

/** The separate API that owns "who may post to this group, and from where". */
export const GROUPS_SETTINGS_SCOPE = 'https://www.googleapis.com/auth/apps.groups.settings';

/**
 * The API names as Google's own console spells them, so an "enable this API"
 * message names a page the reader can actually find.
 */
export const ADMIN_SDK_API = 'Google Admin SDK';
export const GROUPS_SETTINGS_API = 'Google Groups Settings';

// ---------------------------------------------------------------------------
// Which account may do this at all
// ---------------------------------------------------------------------------

/**
 * Resolve an account and REFUSE it unless it is a flagged Workspace
 * administrator. Nothing here touches the network.
 *
 * `account` is required. The message says so plainly rather than defaulting,
 * because the default account on this server is a consumer Gmail mailbox and an
 * admin call is exactly the kind that must never land somewhere by accident.
 */
export function requireAdminAccount(input?: string): AccountConfig {
  if (!input || input.trim().length === 0) {
    throw new Error(
      'account is required on every Workspace-admin tool. Unlike the mail tools, these do NOT '
      + 'fall back to the default account: the default here is an ordinary mailbox, and an '
      + 'administrative call landing on the wrong Workspace is not a mistake worth risking for '
      + `convenience. Pass the alias of the account that administers the Workspace you mean${
        flaggedAliasClause()}.`,
    );
  }

  const account = resolveAccount(input);
  if (account.workspace_admin === true) return account;

  throw new Error(
    `"${account.alias}" (${account.email}) is not marked as a Google Workspace administrator, so `
    + 'this call was refused before it was sent. If that account really does administer a '
    + 'Workspace, add "workspace_admin": true to its entry in accounts.json and run '
    + `npm run auth -- ${account.alias} so it consents to the admin permissions${
      flaggedAliasClause()}.`,
  );
}

/** The " — flagged today: a, b" tail, or an explicit "none are flagged". */
function flaggedAliasClause(): string {
  let flagged: string[] = [];
  try {
    flagged = getAccounts().filter(a => a.workspace_admin === true).map(a => a.alias);
  } catch {
    // accounts.json unreadable is a different problem with its own message;
    // never let listing the aliases become the error a caller sees.
    return '';
  }
  return flagged.length > 0
    ? `. Flagged today: ${flagged.join(', ')}`
    : '. None are flagged today, so no account on this server can make an admin call yet';
}

// ---------------------------------------------------------------------------
// The clients
// ---------------------------------------------------------------------------

interface CachedClients {
  client: Auth.OAuth2Client;
  directory: admin_directory_v1.Admin;
  settings: groupssettings_v1.Groupssettings;
  expiresAt: number;
}

const CLIENT_CACHE = new Map<string, CachedClients>();
const CLIENT_TTL_MS = 50 * 60 * 1000; // 50 minutes, as everywhere else here

/**
 * Both API clients for one account, built together on one OAuth client and
 * cached under that account's address. Keyed by email rather than alias so two
 * aliases pointing at one mailbox share a client, and — much more importantly —
 * two aliases pointing at DIFFERENT Workspaces never do.
 */
async function clientsFor(account: AccountConfig): Promise<CachedClients> {
  const cached = CLIENT_CACHE.get(account.email);
  if (cached && Date.now() < cached.expiresAt) return cached;

  const authClient = await getAuthClient(account);
  const built: CachedClients = {
    client: authClient,
    directory: google.admin({ version: 'directory_v1', auth: authClient }),
    settings: google.groupssettings({ version: 'v1', auth: authClient }),
    expiresAt: Date.now() + CLIENT_TTL_MS,
  };
  CLIENT_CACHE.set(account.email, built);
  return built;
}

/** The Admin SDK Directory client for an account that has already been vetted. */
export async function getDirectoryClient(account: AccountConfig): Promise<admin_directory_v1.Admin> {
  return (await clientsFor(account)).directory;
}

/** The Groups Settings client for an account that has already been vetted. */
export async function getGroupsSettingsClient(
  account: AccountConfig,
): Promise<groupssettings_v1.Groupssettings> {
  return (await clientsFor(account)).settings;
}

// ---------------------------------------------------------------------------
// Which customer a list call is about
// ---------------------------------------------------------------------------

/** Google's own alias for "the Workspace this token belongs to". */
export const MY_CUSTOMER = 'my_customer';

/**
 * Directory list calls take EXACTLY ONE of `customer` and `domain`, and
 * sending both is refused with a message about neither. Default is the whole
 * Workspace; naming a domain narrows to it.
 */
export function customerOrDomain(domain?: string): { customer: string } | { domain: string } {
  const named = domain?.trim();
  return named ? { domain: named } : { customer: MY_CUSTOMER };
}

// ---------------------------------------------------------------------------
// Group settings: one table, both directions
// ---------------------------------------------------------------------------

/**
 * The Groups Settings fields this server will read or write, by the name the
 * tools use. Deliberately an allow-list: the API carries dozens of fields, most
 * of them about the Google Groups web forum rather than about mail, and a tool
 * that accepted all of them would be inviting changes nobody meant to make.
 *
 * `api` is Google's spelling. `kind` decides the conversion — Groups Settings
 * carries every boolean as the STRING "true" or "false", which is the single
 * most surprising thing about it and the reason this table exists at all.
 */
export type GroupSettingKind = 'boolean' | 'enum' | 'text';

/**
 * The Google-side names, as literal types. Keeping them literal is what lets a
 * settings body be built without an assertion: every one of these is
 * `string | null` on `Schema$Groups`, so a `Partial<Record<…, string>>` slots
 * straight in as a request body.
 */
export type GroupSettingApiKey =
  | 'whoCanPostMessage'
  | 'allowExternalMembers'
  | 'whoCanViewGroup'
  | 'whoCanViewMembership'
  | 'whoCanJoin'
  | 'whoCanDiscoverGroup'
  | 'whoCanContactOwner'
  | 'messageModerationLevel'
  | 'spamModerationLevel'
  | 'replyTo'
  | 'customReplyTo'
  | 'includeInGlobalAddressList'
  | 'allowWebPosting'
  | 'isArchived'
  | 'enableCollaborativeInbox'
  | 'membersCanPostAsTheGroup'
  | 'whoCanLeaveGroup'
  | 'name'
  | 'description';

export interface GroupSettingField {
  /** The tool's name for it, snake_case. */
  readonly param: string;
  /** Google's name for it. */
  readonly api: GroupSettingApiKey;
  readonly kind: GroupSettingKind;
  /** Every value Google accepts, for an enum. Verified 2026-09-02. */
  readonly values?: readonly string[];
}

export const GROUP_SETTING_FIELDS: readonly GroupSettingField[] = [
  {
    param: 'who_can_post_message',
    api: 'whoCanPostMessage',
    kind: 'enum',
    values: [
      'NONE_CAN_POST', 'ALL_MANAGERS_CAN_POST', 'ALL_MEMBERS_CAN_POST',
      'ALL_OWNERS_CAN_POST', 'ALL_IN_DOMAIN_CAN_POST', 'ANYONE_CAN_POST',
    ],
  },
  { param: 'allow_external_members', api: 'allowExternalMembers', kind: 'boolean' },
  {
    param: 'who_can_view_group',
    api: 'whoCanViewGroup',
    kind: 'enum',
    values: [
      'ANYONE_CAN_VIEW', 'ALL_IN_DOMAIN_CAN_VIEW', 'ALL_MEMBERS_CAN_VIEW',
      'ALL_MANAGERS_CAN_VIEW', 'ALL_OWNERS_CAN_VIEW',
    ],
  },
  {
    param: 'who_can_view_membership',
    api: 'whoCanViewMembership',
    kind: 'enum',
    values: ['ALL_IN_DOMAIN_CAN_VIEW', 'ALL_MEMBERS_CAN_VIEW', 'ALL_MANAGERS_CAN_VIEW'],
  },
  {
    param: 'who_can_join',
    api: 'whoCanJoin',
    kind: 'enum',
    values: ['ANYONE_CAN_JOIN', 'ALL_IN_DOMAIN_CAN_JOIN', 'INVITED_CAN_JOIN', 'CAN_REQUEST_TO_JOIN'],
  },
  {
    param: 'who_can_discover_group',
    api: 'whoCanDiscoverGroup',
    kind: 'enum',
    values: ['ANYONE_CAN_DISCOVER', 'ALL_IN_DOMAIN_CAN_DISCOVER', 'ALL_MEMBERS_CAN_DISCOVER'],
  },
  {
    param: 'who_can_contact_owner',
    api: 'whoCanContactOwner',
    kind: 'enum',
    values: [
      'ALL_IN_DOMAIN_CAN_CONTACT', 'ALL_MANAGERS_CAN_CONTACT',
      'ALL_MEMBERS_CAN_CONTACT', 'ANYONE_CAN_CONTACT',
    ],
  },
  {
    param: 'message_moderation_level',
    api: 'messageModerationLevel',
    kind: 'enum',
    values: ['MODERATE_ALL_MESSAGES', 'MODERATE_NON_MEMBERS', 'MODERATE_NEW_MEMBERS', 'MODERATE_NONE'],
  },
  {
    param: 'spam_moderation_level',
    api: 'spamModerationLevel',
    kind: 'enum',
    values: ['ALLOW', 'MODERATE', 'SILENTLY_MODERATE', 'REJECT'],
  },
  {
    param: 'reply_to',
    api: 'replyTo',
    kind: 'enum',
    values: [
      'REPLY_TO_CUSTOM', 'REPLY_TO_SENDER', 'REPLY_TO_LIST',
      'REPLY_TO_OWNER', 'REPLY_TO_IGNORE', 'REPLY_TO_MANAGERS',
    ],
  },
  { param: 'custom_reply_to', api: 'customReplyTo', kind: 'text' },
  { param: 'include_in_global_address_list', api: 'includeInGlobalAddressList', kind: 'boolean' },
  { param: 'allow_web_posting', api: 'allowWebPosting', kind: 'boolean' },
  { param: 'is_archived', api: 'isArchived', kind: 'boolean' },
  { param: 'enable_collaborative_inbox', api: 'enableCollaborativeInbox', kind: 'boolean' },
  { param: 'members_can_post_as_the_group', api: 'membersCanPostAsTheGroup', kind: 'boolean' },
  {
    param: 'who_can_leave_group',
    api: 'whoCanLeaveGroup',
    kind: 'enum',
    values: ['ALL_MANAGERS_CAN_LEAVE', 'ALL_MEMBERS_CAN_LEAVE', 'NONE_CAN_LEAVE'],
  },
  { param: 'name', api: 'name', kind: 'text' },
  { param: 'description', api: 'description', kind: 'text' },
];

const FIELD_BY_PARAM = new Map(GROUP_SETTING_FIELDS.map(f => [f.param, f]));

/** What a caller may pass, and what a read hands back. */
export type GroupSettings = Record<string, string | boolean>;

/** The body of a Groups Settings write: Google's names, all values as strings. */
export type GoogleGroupSettings = Partial<Record<GroupSettingApiKey, string>>;

/**
 * Tool names and real booleans in; Google's names and string booleans out.
 *
 * Only the keys that were passed appear in the result, so a patch never
 * restates a setting nobody asked to change. Everything is validated here
 * rather than at Google, because Google's rejection names the camelCase field
 * the caller never typed.
 */
export function toGoogleSettings(settings: GroupSettings): GoogleGroupSettings {
  const body: GoogleGroupSettings = {};

  for (const [param, value] of Object.entries(settings)) {
    if (value === undefined) continue;

    const field = FIELD_BY_PARAM.get(param);
    if (!field) {
      throw new Error(
        `"${param}" is not a group setting this server writes. The ones it does: `
        + `${GROUP_SETTING_FIELDS.map(f => f.param).join(', ')}.`,
      );
    }

    if (field.kind === 'boolean') {
      if (typeof value !== 'boolean') {
        throw new Error(`${param} is true or false, not ${JSON.stringify(value)}.`);
      }
      // The one genuinely surprising thing about this API: it carries booleans
      // as the words "true" and "false", and a real JSON boolean does not work.
      body[field.api] = value ? 'true' : 'false';
      continue;
    }

    if (typeof value !== 'string') {
      throw new Error(`${param} is text, not ${JSON.stringify(value)}.`);
    }

    if (field.kind === 'enum' && !(field.values ?? []).includes(value)) {
      throw new Error(
        `${param}: "${value}" is not one of Google's values. It must be one of `
        + `${(field.values ?? []).join(', ')}.`,
      );
    }

    body[field.api] = value;
  }

  return body;
}

/**
 * Google's answer, projected back to the allow-listed names.
 *
 * Three rules, each of them about not inventing anything: a field Google did
 * not send is simply absent (rather than defaulted, which would report a
 * posture the group does not have); everything outside the allow-list is
 * dropped; and a boolean field carrying something other than "true" or "false"
 * is passed through as the text that arrived, so a change on Google's side
 * shows up instead of quietly reading as false.
 *
 * `email` rides along because it is how the reader knows which address the
 * settings belong to, and it is read-only.
 */
export function fromGoogleSettings(raw: groupssettings_v1.Schema$Groups): GroupSettings {
  const projected: GroupSettings = {};

  if (typeof raw.email === 'string' && raw.email.length > 0) projected.email = raw.email;

  for (const field of GROUP_SETTING_FIELDS) {
    const value = raw[field.api];
    if (typeof value !== 'string') continue;

    if (field.kind === 'boolean') {
      if (value === 'true' || value === 'false') {
        projected[field.param] = value === 'true';
      } else {
        projected[field.param] = value;
      }
      continue;
    }

    projected[field.param] = value;
  }

  return projected;
}

// ---------------------------------------------------------------------------
// Honest failures, on top of the shared translator
// ---------------------------------------------------------------------------

export interface AdminErrorContext {
  /** The MCP tool name the user invoked. */
  tool: string;
  /** What was being acted on, in the words a person would use: "group", "user". */
  target: string;
  /** The address or id that names it. */
  key: string;
  /** Account alias, for a message that has to name whose permission is short. */
  alias: string;
}

/** Google's several ways of saying "there is already one of those". */
const ALREADY_EXISTS_RE = /entity already exists|already exists|duplicate/i;

/**
 * The replacement error for the three Directory failures the shared translator
 * would leave unhelpful, or `undefined` when this is not one of them.
 *
 * Returned rather than thrown, and carrying no status code, so a caller can
 * hand it onward without `withRetry` rewriting it into "re-authenticate".
 *
 * What is deliberately NOT handled here, because the shared translator already
 * does it better: a missing scope (which names the scope and the exact
 * `npm run auth -- <alias>`), an API that was never enabled on the Cloud
 * project (which names the console page), and a rate-limit 403 (which has to
 * stay retryable). A 401 is left alone too — that is the one case where
 * re-authenticating really is the cure.
 */
export function adminApiError(err: unknown, ctx: AdminErrorContext): Error | undefined {
  if (isMissingScopeError(err)) return undefined;

  const status = errorStatus(err);
  const reasons = googleErrorReasons(err);
  const original = googleErrorMessage(err);

  if (status === 409 || (status === 400 && ALREADY_EXISTS_RE.test(original))) {
    return new Error(
      `${ctx.tool}: there is already a ${ctx.target} at "${ctx.key}" in this Workspace, so `
      + 'nothing was created and nothing was changed. Read it with get_group (or list_groups) '
      + `to see what it is set to before deciding what to do next.\n\nOriginal error: ${original}`,
    );
  }

  if (status === 404) {
    return new Error(
      `${ctx.tool}: there is no such ${ctx.target} as "${ctx.key}" in the Google Workspace that `
      + `"${ctx.alias}" administers. That is Google's answer for an address that does not exist `
      + 'AND for one that lives in a different Workspace, so check the spelling and check you '
      + `are using the right account.\n\nOriginal error: ${original}`,
    );
  }

  if (status === 403) {
    if (isRateLimit403(status, err)) return undefined;
    if (reasons.includes('accessnotconfigured')) return undefined;

    return new Error(
      `${ctx.tool}: Google refused this for "${ctx.alias}" (403). The sign-in is fine and the `
      + 'permission was granted — what is missing is the ADMIN ROLE that allows this particular '
      + `action on "${ctx.key}". A Workspace super administrator can grant it in the Admin `
      + 'console under Account > Admin roles. Signing in again will not change this.'
      + `\n\nOriginal error: ${original}`,
    );
  }

  return undefined;
}

/**
 * Wrap a failure that arrived AFTER a create or delete may already have landed.
 *
 * Creates and deletes here run with `maxRetries: 0`, because a gateway timeout
 * can arrive after Google has done the thing: a retried group insert makes two
 * groups and reports one, and a retried user insert makes two people and two
 * paid seats. The shared retry helper is therefore switched off for them, and
 * this says out loud what the caller now has to check — which is more use than
 * "Service Unavailable" on its own, and stops an LLM from simply calling again.
 *
 * A 4xx is returned untouched: nothing was created, so there is nothing to
 * check and no reason to make the reader look.
 */
export function mayHaveLandedError(
  err: unknown,
  status: number | undefined,
  ctx: { tool: string; what: string; check: string },
): unknown {
  const mayHaveLanded = status === undefined || status >= 500;
  if (!mayHaveLanded) return err;

  const original = err instanceof Error ? err.message : String(err);
  const wrapped = new Error(
    `${original}\n\n`
    + `This failure arrived after the request was handed to Google, so ${ctx.what} MAY already `
    + `exist — ${ctx.tool} is deliberately NOT retried, because a retry that succeeded after a `
    + 'timeout would make a second one and report only the first. Check with '
    + `${ctx.check} before calling ${ctx.tool} again.`,
    { cause: err },
  );
  const code = (err as { code?: unknown }).code;
  if (code !== undefined) (wrapped as Error & { code?: unknown }).code = code;
  return wrapped;
}

// ---------------------------------------------------------------------------
// Making one call
// ---------------------------------------------------------------------------

export interface AdminCallContext extends AdminErrorContext {
  /** The API's human name, as `ADMIN_SDK_API` or `GROUPS_SETTINGS_API`. */
  api: string;
  /** The scope THIS call needs, so a missing-grant error names the right one. */
  scope: string;
}

/**
 * Run one Admin SDK or Groups Settings call with the shared retry policy, the
 * shared honest-error translation, and the three extra translations above.
 *
 * The layering matters and is the same as the Sheets client's: `adminApiError`
 * runs INSIDE the retry loop on the RAW Google error, because the reason codes
 * that tell a duplicate from a missing scope do not survive the rewrite; what
 * it returns carries no status, so neither the retry loop nor the shared
 * translator touches it again; and everything it declines to handle travels on
 * to the shared translator exactly as before.
 */
export async function adminCall<T>(
  ctx: AdminCallContext,
  fn: () => Promise<T>,
  opts: { maxRetries?: number } = {},
): Promise<T> {
  return googleApiCall(
    { tool: ctx.tool, api: ctx.api, scope: ctx.scope, alias: ctx.alias },
    async () => {
      try {
        return await fn();
      } catch (err: unknown) {
        throw adminApiError(err, ctx) ?? err;
      }
    },
    opts,
  );
}

/**
 * Run one call that CREATES or DELETES something, with retrying switched off
 * and an honest answer when the outcome is unknown.
 *
 * `withRetry` retries 500, 502, 503 and 504, and a gateway timeout can arrive
 * after Google has already done the thing. Retrying a group insert then makes
 * two groups and reports one; retrying a user insert makes two people and two
 * paid seats. So there is exactly one attempt, and a failure that MIGHT have
 * landed says so and names the read that settles it.
 */
export async function adminCreateCall<T>(
  ctx: AdminCallContext,
  landing: { what: string; check: string },
  fn: () => Promise<T>,
): Promise<T> {
  // The status of the RAW error, kept before the honest-error translation
  // discards it — it is what says whether the write could already have landed.
  let rawStatus: number | undefined;
  try {
    return await adminCall(
      ctx,
      async () => {
        try {
          return await fn();
        } catch (raw: unknown) {
          rawStatus = errorStatus(raw);
          throw raw;
        }
      },
      { maxRetries: 0 },
    );
  } catch (err: unknown) {
    throw mayHaveLandedError(err, rawStatus, { tool: ctx.tool, ...landing });
  }
}

// ---------------------------------------------------------------------------
// Projections — what a caller is handed, and what stays behind
// ---------------------------------------------------------------------------

/** Drop a key rather than emit a null for it. Booleans keep their `false`. */
function present<T extends Record<string, unknown>>(fields: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null) out[key] = value;
  }
  return out as Partial<T>;
}

/** A group as the tools report it: no etags, no kinds, no nonEditableAliases. */
export function projectGroup(group: admin_directory_v1.Schema$Group): Record<string, unknown> {
  return present({
    email: group.email,
    name: group.name,
    description: group.description,
    directMembersCount: group.directMembersCount,
    aliases: group.aliases,
    adminCreated: group.adminCreated,
  });
}

/**
 * A user as a LISTING reports it.
 *
 * The Directory API does not return passwords or hashes on a read, but the
 * projection is written as an allow-list anyway: `Schema$User` carries
 * `password` and `hashFunction` fields, and an object built by omission rather
 * than by selection is one Google schema change away from handing them on.
 */
export function projectUser(user: admin_directory_v1.Schema$User): Record<string, unknown> {
  return present({
    primaryEmail: user.primaryEmail,
    fullName: user.name?.fullName,
    suspended: user.suspended,
    isAdmin: user.isAdmin,
    orgUnitPath: user.orgUnitPath,
    aliases: user.aliases,
    lastLoginTime: user.lastLoginTime,
  });
}

/** A user as a SINGLE read reports it: the listing fields plus the details. */
export function projectUserDetail(user: admin_directory_v1.Schema$User): Record<string, unknown> {
  return {
    ...projectUser(user),
    ...present({
      recoveryEmail: user.recoveryEmail,
      creationTime: user.creationTime,
      agreedToTerms: user.agreedToTerms,
      isEnrolledIn2Sv: user.isEnrolledIn2Sv,
      changePasswordAtNextLogin: user.changePasswordAtNextLogin,
    }),
  };
}

/** A membership as the tools report it. */
export function projectMember(member: admin_directory_v1.Schema$Member): Record<string, unknown> {
  return present({
    email: member.email,
    role: member.role,
    type: member.type,
    status: member.status,
    deliverySettings: member.delivery_settings,
  });
}

/**
 * The group's email address, which is the ONLY key Groups Settings accepts.
 *
 * An id or an alias works perfectly well for every Directory call and is a 404
 * at Groups Settings, so anything that is not already an address is resolved
 * through the Directory first rather than sent and left to fail confusingly.
 */
export async function resolveGroupEmail(
  directory: admin_directory_v1.Admin,
  groupKey: string,
  ctx: AdminCallContext,
): Promise<{ email: string; group?: admin_directory_v1.Schema$Group }> {
  if (groupKey.includes('@')) return { email: groupKey };

  const found = await adminCall(ctx, () => directory.groups.get({ groupKey }));
  const email = found.data.email;
  if (!email) {
    throw new Error(
      `${ctx.tool}: Google returned no email address for group "${groupKey}", and the group's `
      + 'address is the only key its settings can be read or written by.',
    );
  }
  return { email, group: found.data };
}
