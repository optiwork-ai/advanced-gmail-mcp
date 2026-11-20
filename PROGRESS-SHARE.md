# GM-SHARE-1 — builder progress (share_drive_file + unshare_drive_file)

Contract: `/Users/steve/Claude-Projects/shared/active-work/2026-11-20-gmail-mcp-share-tool/CONTRACT-DRAFT-GM-SHARE-1.md`
with `AMENDMENT-A1-UNSHARE.md` (both FROZEN 11/20/2026 ~6:10 AM ET). Tier 2, standard v1.
Branch `feat/share-drive-file`, worktree `/Users/steve/Claude-Projects/2-backbone/advanced-gmail-mcp-share-wt`.
Base: `d480564234ca8a60a9d42d9860669b5d5f5b3d50` (main, clean, confirmed before the worktree was made). The live
checkout was never touched. No live Google call was made (no tokens in the worktree).
Lane evidence folder (`$LANE`): `/Users/steve/Claude-Projects/shared/active-work/2026-11-20-gmail-mcp-share-tool/`.

## Baseline (untouched worktree)
- `npm install` in the worktree; `package-lock.json` changed and was reverted with `git checkout -- package-lock.json`.
- `npm test`: 32 files, 1159 passed. `npm run typecheck`: clean. Output: `$LANE/scans/baseline-npm-test.txt`,
  `$LANE/scans/baseline-typecheck.txt`.

## Commits (base..tip)
- DONE `01135aa` test(U1): T1-T14 written first. Fail-before: `$LANE/scans/u1-fail-before.txt` (the share test file
  fails to load, "Failed to load url ./drive-share-file.js"; 4 roster tests fail at 71).
- DONE `9e60377` feat(U1): `share_drive_file`. Pass-after: `$LANE/scans/u1-pass-after.txt` (37 passed). Full suite 33
  files, 1188 passed; typecheck clean.
- DONE `d31a147` test(U2): T15-T27, T1 amended to 72, share description test gains "undone with unshare_drive_file"
  (A5). Fail-before: `$LANE/scans/u2-fail-before.txt` (unshare test file fails to load; 5 tests fail).
- DONE `d5a009b` feat(U2): `unshare_drive_file`. Pass-after: `$LANE/scans/u2-pass-after.txt` (69 passed).
- DONE `aa1b8b6` docs (A10): README `:9` 72 tools and "and sharing with named people"; scope note after `:45`; `:201`
  corrected; two rows after the `upload_drive_file` row; CHANGELOG `[Unreleased]` / `### Added` two lines; comments at
  `src/tools/index.ts:128-137` and `src/tools/drive-upload-file.ts:16` corrected.
- This file and the scans: the commit after `aa1b8b6`.

## Tip
- `npm test`: 34 files, 1220 passed (baseline 1159; +61: 28 in `drive-share-file.test.ts`, 32 in
  `drive-unshare-file.test.ts`, 1 roster test). `npm run typecheck`: clean. Output: `$LANE/scans/tip-npm-test.txt`,
  `$LANE/scans/tip-typecheck.txt`.

## Where the code is
- `src/drive/client.ts` (beside `uploadFile`, as the contract allowed): ONE definition each of the shared pieces used by
  both tools: `checkAddress` / `checkDistinct` / `checkFileId` (address and id rules), `permissionCall` (one
  permissions call through `googleApiCall`, keeping the raw Google error to tell a file-level stop from one person's
  failure), `listPermissions` (list with paging), `notReachableReason` (the "only files it created" words),
  `PermissionResult` / `PermissionChangeResult` (result shape). Then `shareFile` and `unshareFile`. The module header
  comment (it said only `uploadFile` writes) was corrected in the unit commits.
- `src/tools/drive-share-file.ts`, `src/tools/drive-unshare-file.ts`: thin handlers in the R1 shape.
- Tests: `src/tools/drive-share-file.test.ts`, `src/tools/drive-unshare-file.test.ts` (handler to client to a mocked
  `googleapis`, per R15's client-test mocking), `src/tools/index.test.ts` (T1).

## Test map
- T1 `index.test.ts` "registers 72 tools", "can actually be LISTED", "read side plus write side", "registers both
  Drive sharing tools, on the WRITE side".
- T2-T14 `drive-share-file.test.ts` (test names carry the T number), plus one description test.
- T15-T27 `drive-unshare-file.test.ts` (test names carry the T number), plus one description test.

## Verification rows (ratified at base `d480564`, read 11/20/2026)
- R1 VERIFIED `src/tools/drive-upload-file.ts:15-21` (comment `:16` "The only Drive tool that writes.";
  `registerUploadDriveFile` `:18`; `'upload_drive_file'` `:20`) and `:45-51` (catch returns `Error: ${message}`,
  `isError: true`).
- R2 VERIFIED `src/drive/client.ts:42-64` (`getDriveClient`, `resolveAccount`, `CLIENT_CACHE` `:34`,
  `google.drive({ version: 'v3', auth: authClient })` `:55`).
- R3 VERIFIED, lines CORRECTED (no interface change): `googleApiCall({ tool: 'upload_drive_file', api: 'Google Drive',
  scope: DRIVE_FILE_SCOPE, alias }, ...)` is `src/drive/client.ts:303-326` (cited `:303-311`); `supportsAllDrives: true`
  `:324`; `DRIVE_FILE_SCOPE` `:78`.
- R4 VERIFIED `src/scope-error.ts:136-146` (`isMissingScopeError`), `:152-161` (`scopeError`, names the scope and
  `npm run auth -- ${ctx.alias}`).
- R5 VERIFIED (pinned by R20) `src/google-api-error.ts:103-115` (`googleApiCall` = `withRetry` with the translator
  inside), `:62-90` (`translateGoogleApiError`). `withRetry` at `src/gmail/client.ts:120-154` rewrites 401 into
  "Authentication error (401) ... Re-authenticate" and retries 429/500/502/503/504 and rate-limit 403s only.
- R6 VERIFIED `src/sheets/client.ts:165-172` (`isOutsideAppScope`, not exported), message `:181-197`. NOT REUSED: its
  meaning is "404 OR any non-scope, non-rate-limit 403", but the frozen interface makes only a 404 file-level and a
  non-scope 403 a per-person failure (base section 4, T9). Reusing it would have changed T9's behavior. See Q1.
- R7 VERIFIED `src/tools/index.ts:44` (import), `:144` (`registerUploadDriveFile(server)` inside `:138-147`), comment
  `:128-137`.
- R8 VERIFIED `src/tools/index.test.ts:93-95` and `:102` (70), `:68` (`'upload_drive_file'` in WRITE_TOOLS), `:116-118`
  roster equals READ_TOOLS plus WRITE_TOOLS. Superseded by R22 (72).
- R9 VERIFIED `README.md:9` "70 tools"; `:201` "Drive is read-only except `upload_drive_file` and
  `create_google_doc`"; `:211` the upload row; scope note `:45`.
- R10 VERIFIED `CHANGELOG.md:8` `## [Unreleased]`, `:10` `### Added`.
- R11 VERIFIED `package.json:10-11` (`"typecheck": "tsc --noEmit"`, `"test": "vitest run"`).
- R12 VERIFIED `/Users/steve/Claude-Projects/.mcp.json:3-6` (`tsx` running the live checkout's `src/server.ts`; no
  build step).
- R13 VERIFIED, lines CORRECTED: `log('info', 'upload_drive_file', { account, file_id, folder_id, bytes, mime_type,
  convert_to })` at `src/drive/client.ts:336-343` (cited ~`:333-341`); `send_email` logs no recipients at
  `src/gmail/client.ts:1158-1162`.
- R14 VERIFIED `PROGRESS-HANDLED.md:4-9` (worktree beside the checkout, base recorded, `npm install`, lockfile
  reverted, counts recorded). Followed here.
- R15 VERIFIED `src/tools/drive-upload-file.test.ts:15-20,29-39`; `src/drive/client.test.ts:17-41`.
- R16 VERIFIED `/Users/steve/.claude/projects/-Users-steve-Claude-Projects/memory/feedback-share-drive-files-before-sending.md:20-31`
  (named individuals only; `POST .../permissions?sendNotificationEmail=false` with `{role, type: user, emailAddress}`;
  then GET the list; files the server created only).
- R17 VERIFIED `/Users/steve/Claude-Projects/.claude/learnings/recommendation-misses.md:4434` (2026-11-20 appraiser
  mobile chair entry).
- R18 VERIFIED `src/tools/workspace-group-members.ts:140-147` (`'remove_group_member'`, "this ends a membership, it does
  not delete anything", "a get_group taken immediately afterwards may still list the address"); `star_email` /
  `unstar_email` `src/tools/index.test.ts:62-63`.
- R19 VERIFIED `src/google-api-error.ts:96-107` (`maxRetries: 0` note; gateway timeout after the write landed).
  Default retries stay on for both tools; unshare status comes from the read-back.
- R20 VERIFIED `src/google-api-error.ts:62-67` (missing scope to `scopeError`; non-403 returned as is) and `:85-89`
  (other 403 restated without re-auth advice).
- R21 VERIFIED `src/tools/index.ts:128-137` and `README.md:201`; both corrected in `aa1b8b6`.
- R22 VERIFIED `src/tools/index.test.ts:66-69`, `:93-96`, `:102`; now 72.
No CORRECTED row changes an interface.

## Vendor rows (Google Drive v3, read with WebFetch 11/20/2026; no page shows a "Last updated" date)
Pages: `https://developers.google.com/workspace/drive/api/reference/rest/v3/permissions/create`, `.../permissions/list`,
`.../permissions/delete`, `.../rest/v3/permissions` (the resource), plus `https://developers.google.com/workspace/drive/api/guides/manage-sharing`
and `https://developers.google.com/workspace/drive/api/guides/handle-errors`.
- V1 CONFIRMED. create: `sendNotificationEmail` "Whether to send a notification email when sharing to users or
  groups. This defaults to `true` for users and groups". Sent as the literal `false` on every create.
- V2 NOT DOCUMENTED on any page read (no text on a no-notification share to an address without a Google account).
  Built as the contract says: whatever Google refuses is that person's `failed` with Google's words; the notification
  is never turned on. Real-boundary test to observe.
- V3 NOT DOCUMENTED for a repeat create on the same file. The sharing guide: "The `permissionId` remains the same for
  that user or group across all files, folders, and shared drives" (so a repeat cannot add a second entry with a new
  id). Whether a repeat at a lower role lowers it is not stated. Every attempt carries `sendNotificationEmail: false`,
  so a retry sends no mail. Reported as unconfirmed, not disproved.
- V4 NOT DOCUMENTED (a group address sent as `type: "user"`). The tool never sends `type: "group"`; Google's answer is
  per-person.
- V5 CONFIRMED. list: `GET .../files/{fileId}/permissions`; `pageSize` "The maximum value is 100"; unspecified returns
  "the entire list of permissions for non-shared drives" and at most 100 for shared drives; `pageToken` from
  `nextPageToken`, which "will be absent if the end of the permissions list has been reached". `supportsAllDrives` is a
  listed parameter on create, list and delete; all three calls send `true` (as the upload does, R3). Resource: "Permission
  `kind`, `ID`, `type`, and `role` are always returned."
- V6 CONFIRMED. delete: `DELETE .../files/{fileId}/permissions/{permissionId}`; `supportsAllDrives` accepted; "The
  request body must be empty"; "If successful, the response body is an empty JSON object"; scopes list
  `https://www.googleapis.com/auth/drive.file`. No notification parameter exists on delete and no page mentions a
  removal notice. Also on the page: "Concurrent permission modifications (such as update or delete) on the same file
  ... aren't supported"; the tool deletes one at a time, awaited. U2 not stopped.
- V7 NOT DOCUMENTED. `emailAddress`: "Output only. The email address of the user or group to which this permission
  refers." Nothing on form or case, and nothing on scope-dependent population. The frozen matching rule fails safe
  (`not_found`); the real-boundary test records the observed form.
- V8 PARTLY DOCUMENTED. Inherited: "Inherited permissions cannot be revoked directly on child items";
  `cannotModifyInheritedTeamDrivePermission` (403) "Cannot update or delete an inherited permission on a shared drive
  item." An already-gone permission's answer is not documented (404 expected). Both are per-person outcomes as built
  (T21, T24).
- V9 NOT DOCUMENTED. No timing is given; the guide says "To confirm that a permission is removed, call" the list
  method. A still-listed id after a good delete is `unconfirmed`; no wait or poll was added.
- Adjacent finding (not a V row; written as Q1 in `$LANE/QUESTIONS-FOR-FABLE.md`, non-blocking): the error guide lists
  `appNotAuthorizedToFile` (403) "The user has not granted the app {appId} {verb} access to the file {fileId}." Since
  this server also holds `drive.readonly`, a file it did not create may answer 403, not 404; as built that is a
  per-person `failed` with R5's 403 words, not the "only files it created" message. Safe either way.

## Builder's choices inside the contract (flagged for the checker)
- Validation happens twice on purpose: the zod parameter shape (so a client's JSON Schema shows `.strict()` recipients,
  the role enum and `min(1)`, and the SDK refuses early), and in `shareFile` / `unshareFile` themselves (the safety
  boundary; the tests call the handler directly and prove it). Both refuse; neither sends anything.
- `file_id` containing `/` is refused (the contract's "an id, not a URL"); no other shape check.
- `share_drive_file`: when a file-level failure leaves nothing granted, the tool returns the `Error:` text with
  `isError` and skips the read-back (nothing to confirm). When something was granted first, the read-back runs and the
  result is JSON with `success: false`.
- `unshare_drive_file`: the read-back always runs after the first list succeeds (B4 step 3), even when no delete was
  attempted. After a file-level stop during the deletes, every later address is `failed` with that reason (B4). An
  attempted delete's final status always comes from the read-back rule.
- Read-back failure: `share_drive_file` returns `permissions: null` with `readBackError`; `unshare_drive_file` returns
  the first list with `permissionsTakenBeforeRemovals: true` and `readBackError`.
- `drive.permissions.create` asks for `fields: 'id,type,role,emailAddress'`; the list asks for
  `nextPageToken,permissions(id,type,role,emailAddress,displayName,domain,deleted)` with `pageSize: 100`.
- Log events `share_drive_file` and `unshare_drive_file`: alias, file id, counts, statuses (unshare), roles,
  permission ids, whether the read-back succeeded. No address (T13, T27).

## Scans (code range d480564..aa1b8b6, gitleaks re-run on d480564..tip including this file; output in `$LANE/scans/`)
- gitleaks 8.30.1, `gitleaks git --log-opts="d480564..aa1b8b6" --redact`: 5 commits scanned, no leaks found
  (`gitleaks.txt`).
- osv-scanner 2.7.0, `osv-scanner scan source --lockfile=package-lock.json`: `package.json` and `package-lock.json`
  unchanged from base (0 diff lines), so every finding is pre-existing: 22 packages, 102 known vulnerabilities (4
  Critical, 26 High, 62 Medium, 10 Low). Recorded, not fixed (`osv-scanner.txt`).
- semgrep 1.181.0 with ONLY `/Users/steve/Claude-Projects/shared/scan-rules/semgrep/typescript.yml` and
  `javascript.yml` (no registry pack), `--metrics=off`: the 8 changed source files, 74 rules, 0 findings
  (`semgrep-changed-files.txt`); all of `src`, 122 files, 0 findings (`semgrep-src.txt`).

## Not done here (each its own go)
Merge, reload, push, the real-boundary test (B6), the memory recipe update. The worktree stays until the push decision.
