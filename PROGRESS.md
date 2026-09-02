# PROGRESS — feat/workspace-admin-access (v1.11.0)

Branch cut from `main @ 566081b` (v1.10.0, 55 tools, **928 tests**, 27 files, all green).
Contract: `shared/active-work/2026-09-02-google-workspace-admin-access/BUILD-CONTRACT.md`.

Builder session: cold-start Opus, no channel to Steve. **No live Google call was made by
this session.** No credential file was created, copied or symlinked.

## Environment note the chair should read

The Mac's disk hit **zero bytes free** twice during this build (once during `npm ci` in the
fresh worktree, once mid-edit). `npm cache clean --force` plus removing `~/.npm/_cacache`
freed the headroom this build ran on; free space stayed around **220 MB** afterwards, and
free inodes fell from 7.7M to 2.2M in the same window. Nothing else outside the worktree was
touched. This is not a defect in the branch, but the machine is one big download away from
blocking the next build — the biggest caches sitting there are Telegram (2.2 GB), Google
(1.1 GB) and ms-playwright (1.0 GB), and they are Steve's to clear, not a builder's.

## Units, in the contract's §5 order

| # | Unit | Commit | State |
| --- | --- | --- | --- |
| 1 | Piece A tests (FAIL-before recorded) | `7a739fe` | done |
| 2 | Piece A implementation | (this commit) | done |
| 3 | Piece B client + settings-map tests | (this commit) | done |
| 4 | Piece B client implementation | (this commit) | done |
| 5 | Tool tests | (this commit) | done |
| 6 | Tools + registration | (this commit) | done |
| 7 | Docs + version | | |
| 8 | Live harness | | |

## FAIL-before evidence

### Unit 1 — Piece A (per-account scope sets)

Committed the three test additions, then ran them against **unchanged** `src/config.ts` and
`src/gmail/auth.ts`.

`npx vitest run src/gmail/auth-admin-scopes.test.ts src/gmail/auth-admin-status.test.ts src/config.test.ts`

```
 ❯ src/gmail/auth-admin-scopes.test.ts (12 tests | 8 failed)
 ❯ src/gmail/auth-admin-status.test.ts  (7 tests | 4 failed)
 ✓ src/config.test.ts (16 tests)
 Test Files  2 failed | 1 passed (3)
      Tests  12 failed | 23 passed (35)
```

Full list: `evidence/FAIL-before-piece-A.txt`.

The four new `config.test.ts` cases pass at RUNTIME before the change — JavaScript carries an
extra JSON field whether the interface names it or not — so their fail-before is on the
**type** check, which is where that half of the unit actually bites:

```
src/config.test.ts(95,60): error TS2353: Object literal may only specify known properties,
  and 'workspace_admin' does not exist in type 'AccountConfig'.
src/gmail/auth-admin-scopes.test.ts(71,9): error TS2339: Property 'ADMIN_SCOPES' does not
  exist on type 'typeof import(".../src/gmail/auth")'.
src/gmail/auth-admin-scopes.test.ts(71,52): error TS2339: Property 'scopesFor' does not exist
  ...
```

Full output: `evidence/FAIL-before-piece-A-typecheck.txt`.

### Unit 2 — Piece A green

`npm test` **928 → 951** (29 files), `npm run typecheck` clean.

### Unit 3 — Piece B client (tests first)

`npx vitest run src/workspace-admin/` and `npm run typecheck` against a tree with no
`src/workspace-admin/client.ts` in it:

```
 FAIL  src/workspace-admin/client.test.ts [ src/workspace-admin/client.test.ts ]
Error: Failed to load url ./client.js ... Does the file exist?
 Test Files  1 failed (1)
      Tests  no tests
src/workspace-admin/client.test.ts(75,18): error TS2307: Cannot find module './client.js'
  or its corresponding type declarations.
```

Full output: `evidence/FAIL-before-piece-B-client.txt`. The five remaining `TS7006` lines in
that file are the same missing module seen from the other end — with no types for
`GROUP_SETTING_FIELDS`, its callbacks have nothing to infer from.

### Unit 4 — Piece B client green

`npm test` **951 → 996** (30 files), `npm run typecheck` clean.

Four assertions in the unit-3 test file were wrong about the module, not the other way
round, and were corrected here rather than the code being bent to them: three cache tests
shared warmed accounts with each other (fixed by giving each its own alias — the client
cache is process-wide on purpose and has no reset hatch), and one regex expected wording
the message does not use. Nothing that was being proven got weaker.

### Unit 5 — the fourteen tools (tests first)

`npx vitest run src/tools/` and `npm run typecheck` against a tree with none of the tool
modules in it:

```
 ❯ src/tools/workspace-admin-tools.test.ts (0 test)
 ❯ src/tools/read-only-tools.test.ts (0 test)
 ❯ src/tools/index.test.ts (7 tests | 3 failed)
 FAIL  registerAllTools > registers 69 tools
 FAIL  registerAllTools > is exactly the read side plus the write side
 FAIL  registerAllTools > registers all fourteen Workspace-admin tools
 Test Files  3 failed | 8 passed (11)
      Tests  3 failed | 144 passed (147)
src/tools/workspace-admin-tools.test.ts(92,16): error TS2307: Cannot find module
  './workspace-list-domains.js' ... (and twelve more)
```

Full output: `evidence/FAIL-before-piece-B-tools.txt`.

### Unit 6 — the fourteen tools green

`npm test` **996 → 1,131** (31 files), `npm run typecheck` clean, roster 55 → **69**.

**A real defect was caught here, and only by leaving the unit tests behind.** The first
version of `create_group` took its injectable retry timer as a tool parameter,
`sleep: z.function()`. Every unit test passed. But the MCP SDK converts every registered
tool's parameter shape to JSON Schema in one pass when a client asks `tools/list`, and a
function has no JSON Schema — so the conversion THROWS and the server lists **nothing at
all**, for all 69 tools, not just that one. It was found by driving a real `McpServer`
through a real `tools/list` rather than by testing handlers.

The fix is the split `src/calendar/client.ts` already uses for the Meet-room poll: `sleep`
is an option on an exported `createGroup()` function, never a tool parameter, and the tool
is a thin wrapper. `src/tools/index.test.ts` now lists the whole roster through the real
SDK on every run, so no future tool can take the server's listing down this way.

## Decisions taken inside the contract's frame

- **The `[admin]` marker reads the TOKEN first, the flag second.** The contract gives three
  states; the fourth — flag removed while the token still carries the grant — is not named in
  it. Reporting `[admin]` there is the honest reading: un-flagging changes what the NEXT
  consent asks for, not what the account can do this minute, and a board that went quiet
  about live directory power would be hiding it. Pinned by a test that says so.

## Deviations, drops and things deliberately not done

- **The `settings` zod shape lives in `src/tools/shared-params.ts`, the conversion table in
  `src/workspace-admin/client.ts`.** shared-params.ts is where this repo already keeps zod
  shapes more than one tool uses, and a table generated from zod (or zod generated from the
  table) loses the static typing that makes the tools readable. The two are held together by
  a test that compares them key by key and value by value, so they cannot drift.
- **`get_group` reports a settings or members failure BESIDE the group, not instead of it.**
  The contract does not say what happens when the Groups Settings API is off. Failing the
  whole read would make `get_group` useless on a project with one API switched off, but a
  silently absent `settings` block reads as "no restrictions" — the opposite of the truth.
  So the group comes back with `settings: null`, a `settings_error`, and a note saying in
  plain words not to read the absence as permission.
- **`users.patch`, not `users.update`.** The contract asked which the installed types expose:
  `node_modules/googleapis/build/src/apis/admin/directory_v1.d.ts:5808` declares
  `patch(params?: Params$Resource$Users$Patch, …): GaxiosPromise<Schema$User>` alongside
  `update`, so `update_workspace_user` uses `patch` and sends only the fields it was given.
  `update` replaces a user record wholesale, which would blank everything not restated.
