# PROGRESS-FIX — attachment metadata vs Gmail's rotating attachmentIds

Branch `fix/attachment-id-rotation`, worktree
`/Users/steve/Claude-Projects/2-backbone/advanced-gmail-mcp-wt/attachment-fix`, off `main` @ 621a302.

Baseline before any change: **735 tests / 0 failures, typecheck clean.**

## The defect (chair-confirmed live 2026-08-28)

Two consecutive `users.messages.get(format:'full')` on the SAME message return DIFFERENT
`attachmentId`s for the same part. `findAttachmentInfo` re-fetched the message and matched on
`attachmentId` equality, so the match missed and `getAttachment` fell back to filename
`attachment` + `application/octet-stream` — which kills the image content block on real mail and
degrades the filename on save_dir writes. Mocks return stable ids, so 735 tests could not see it.

## Units

### AF1 — carry the stable key (DONE)

- `AttachmentInfo.partId?: string` (src/gmail/types.ts) with the note that `attachmentId` is NOT
  an identity across fetches.
- `extractAttachments` populates it from `payload.partId`, omitted when Gmail sends none.
- `read_email` / `get_thread` therefore surface `attachments[].partId`.
- FAIL-before: `carries Gmail's stable partId through to read_email` fails at HEAD (field absent),
  passes after. 735 → 737 green, typecheck clean.
- Deferred by one commit ON PURPOSE: the `get_attachment` description sentence naming `part_id`
  lands in AF2, with the parameter it describes — a description promising a parameter that does
  not exist yet would be a false description in the AF1 commit.

### AF2 — robust lookup (DONE)

- `get_attachment` gains optional `part_id`; `getAttachment` gains `partId`.
- Lookup order in `findAttachmentInfo`: (1) partId when supplied, (2) attachmentId equality,
  (3) size fallback AFTER the bytes are fetched — the one part whose declared body size equals the
  decoded byte length wins; zero or ambiguous keeps the octet-stream fallback and adds a `note`
  telling the caller to pass `part_id`.
- Size-gate semantics preserved: an identified oversized part is refused BEFORE download; an
  unidentified one is gated on the fetched length.
- `AttachmentData.note?: string` carries the could-not-identify explanation.
- FAIL-before: `src/gmail/attachment-id-rotation.test.ts` — mocked `messages.get` returns a ROTATED
  attachmentId on the second call. At HEAD~ both the size-fallback and part_id paths yield
  `application/octet-stream` and no image block; after AF2 both yield `image/png` with the image
  block.
- Callers checked: the forward/re-attach path (`forwardMessage`) uses `fetchAttachmentBytes` with
  metadata from its OWN single fetch and never calls `findAttachmentInfo` — unaffected. It is the
  only other consumer of attachment metadata.

### AF3 — harness fixes (DONE, lane folder, not the repo)

`/Users/steve/Claude-Projects/shared/active-work/2026-08-27-gmail-mcp-upgrade/round2-acceptance/`:

- **acceptance.ts** — static absolute imports replaced by dynamic imports rooted at
  `process.env.REPO_ROOT` (default: the live checkout), so a candidate branch can be accepted
  before merge. `import type` cannot follow a dynamic path, so the handful of fields the harness
  reads are declared locally and partially — the SHIPPED code still runs.
- **package.json** (new, 4 lines, `{"type":"module"}`) — the harness sits outside the repo's own
  package scope, so tsx was treating it as CJS and refusing top-level `await import`. This marks
  the folder ESM. It is the whole reason the documented `acceptance.ts` path could stay unchanged
  instead of becoming `.mts`.
- **check D** — now runs BOTH paths and FAILs if either misses the image block: with `part_id`
  from read_email, and without it so the size fallback must identify the part. The no-part_id
  path is the ordinary case and the one that was broken.
- **check B** — relabelled. A success is now
  `PASS (drive.file suffices for app-created docs — consent NOT implied)`; Round 1's
  "PASS-POSTCONSENT" on this check was false.
- **check B2** (new) — the honest consent test: an EXISTING Google Doc the app did not create
  (Drive search `mimeType = 'application/vnd.google-apps.document'`, throwaway excluded), edited
  only through a find/replace whose `find` is a fresh `randomUUID()`. Post-consent success is a
  zero-match no-op; a non-zero change count is a FAIL. PASS-PRECONSENT / PASS-POSTCONSENT.
- **check I** — trashes the throwaway via `drive.files.update({trashed:true})` on the server's own
  `getDriveClient` (drive.file covers app-created files). No more litter, no manual step.
- **README-RUN.md** — rewritten for `REPO_ROOT`, the symlink table, and the changed checks.

Dry-run proof (no network): `--dry` with `REPO_ROOT` pointing at this worktree resolves every
module and captures all four handlers; the same command with no `REPO_ROOT` resolves the live
checkout and its accounts. The dry run prints whether the loaded checkout accepts `part_id`
(worktree: "yes (AF2 present)"; live checkout: "NOT FOUND — predates the attachment fix"), so a
run aimed at the wrong tree is visible in one line.

The lane folder is UNTRACKED in the workspace repo (the chair never committed it), so nothing was
committed there — the primary owns `shared/` edits. The files are on disk.

## Symlinks the chair must create for a LIVE run against this worktree

`src/config.ts` builds these from its OWN file location, so the worktree needs its own copies:

```
ln -s /Users/steve/Claude-Projects/2-backbone/advanced-gmail-mcp/accounts.json     /Users/steve/Claude-Projects/2-backbone/advanced-gmail-mcp-wt/attachment-fix/accounts.json
ln -s /Users/steve/Claude-Projects/2-backbone/advanced-gmail-mcp/credentials.json  /Users/steve/Claude-Projects/2-backbone/advanced-gmail-mcp-wt/attachment-fix/credentials.json
ln -s /Users/steve/Claude-Projects/2-backbone/advanced-gmail-mcp/tokens            /Users/steve/Claude-Projects/2-backbone/advanced-gmail-mcp-wt/attachment-fix/tokens
```

- `accounts.json` — `config.ts:23`, read only.
- `credentials.json` — `config.ts:94`, read only.
- `tokens/` (directory) — `config.ts:98`, read AND written (refreshed access tokens save back).
  One symlinked directory keeps the worktree and the live checkout on one set of tokens.
- `cursors/` (directory) — `config.ts:109`, written, **check H only**. Symlink it if H should
  continue the live checkout's remembered position; otherwise leave it and set
  `GMAIL_MCP_CURSOR_DIR`, and H will seed a fresh cursor and say so.

All four are gitignored. Nothing else resolves a path against the project root.

## Standing constraints honored

No push, no deploy, no live Google calls (mocks only), no credentials/IAM/DNS touched, nothing
spawned, live checkout `/Users/steve/Claude-Projects/2-backbone/advanced-gmail-mcp` untouched,
`package-lock.json` byte-identical to HEAD.
