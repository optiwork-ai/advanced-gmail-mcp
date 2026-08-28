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

`/Users/steve/Claude-Projects/shared/active-work/2026-08-27-gmail-mcp-upgrade/round2-acceptance/acceptance.ts`:
dynamic imports rooted at `REPO_ROOT`; check D exercises both the part_id and the no-part_id
(size-fallback) paths; check B relabelled; new check B2 (existing non-app-created Doc, unmatchable
find); check I trashes via `drive.files.update({trashed:true})`.

## Standing constraints honored

No push, no deploy, no live Google calls (mocks only), no credentials/IAM/DNS touched, nothing
spawned, live checkout `/Users/steve/Claude-Projects/2-backbone/advanced-gmail-mcp` untouched,
`package-lock.json` byte-identical to HEAD.
