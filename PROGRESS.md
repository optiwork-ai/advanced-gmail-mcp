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
| 5 | Tool tests | | |
| 6 | Tools + registration | | |
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

## Decisions taken inside the contract's frame

- **The `[admin]` marker reads the TOKEN first, the flag second.** The contract gives three
  states; the fourth — flag removed while the token still carries the grant — is not named in
  it. Reporting `[admin]` there is the honest reading: un-flagging changes what the NEXT
  consent asks for, not what the account can do this minute, and a board that went quiet
  about live directory power would be hiding it. Pinned by a test that says so.

## Deviations, drops and things deliberately not done

- **`users.patch`, not `users.update`.** The contract asked which the installed types expose:
  `node_modules/googleapis/build/src/apis/admin/directory_v1.d.ts:5808` declares
  `patch(params?: Params$Resource$Users$Patch, …): GaxiosPromise<Schema$User>` alongside
  `update`, so `update_workspace_user` uses `patch` and sends only the fields it was given.
  `update` replaces a user record wholesale, which would blank everything not restated.
