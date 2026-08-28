# ROUND 2 — Builder A (gmail repo) progress

Contract: `shared/active-work/2026-08-27-gmail-mcp-upgrade/BUILD-CONTRACT-ROUND2.md` (FROZEN).
Evidence pack: `round2-sweep-evidence.json` (normative for unit scope).

## Environment / concurrency notes

- **Baseline sha (read fresh, `git log -1 main` at start): `a513a81089f46e6c5c8d1b1d383f3c657d8f7609`**
  — "docs(progress): record the docs commit sha".
- Branch `feat/round2-enhancements`, created off `main` at that sha.
- **Isolated worktree** (the live checkout was never touched — it serves the running MCP
  server to other sessions):
  `/private/tmp/claude-501/-Users-steve-Claude-Projects-2-backbone-advanced-gmail-mcp/103223c4-7676-4d7d-9a3d-198956ea26d8/scratchpad/wt-gmail-round2`
- Live checkout state at start: **clean**, on `main` at the baseline sha. Nothing odd.
- `node_modules` was absent in the fresh worktree. Ran `npm install --no-audit --no-fund`
  inside the worktree (167 packages). It rewrote two lines of `package-lock.json`
  (registry metadata); that change was reverted with `git checkout package-lock.json`
  so the lockfile stays exactly as committed. No `NODE_PATH` hack was needed.

## BASELINE SUITE (untouched worktree, before any edit)

- `npm test` → **13 files, 578 passed, 0 failed. GREEN.**
- `npm run typecheck` → **clean, exit 0.**
- Gate for this build is therefore the strict one: **578 + new tests, all green,
  zero failures.**

## Units

### G1 — unsubscribe confirm gate + honest benign case + delete_label enforcement — DONE
- Commit: `9590c9f`
- FAIL-before: `npx vitest run src/gmail/api.test.ts` → **6 failed | 119 passed (125)**
  before the implementation (the six new gate/benign assertions).
- PASS-after: full suite **587 passed (587)**, typecheck clean.
- What changed:
  - `unsubscribeFromEmail` takes `confirm?: boolean`. The **mailto fallback**, which is a
    real outbound send from the owner's account, is refused without `confirm: true`; the
    refusal names the recipient, subject and body it would have sent, and carries any
    prior HTTPS failures. The **one-click HTTPS path is deliberately NOT gated** — it puts
    no mail in anyone's mailbox and is the path that should be preferred.
  - An email with **no `List-Unsubscribe` header now returns `success: true`** with
    "nothing to unsubscribe from". It was reported as a failure, so Claude retried and
    apologised for a normal outcome. A header it cannot parse is still a failure.
  - `deleteLabel` enforces the confirmation its tool description has always stated:
    `confirm: true` or the call throws, **before** the log line and before the API call
    (mirrors the vacation guard, 25bac29).
  - Tool schemas + descriptions for `unsubscribe_email` and `delete_label` state the rules;
    README rows updated.
- **Restated, not loosened:** two pre-existing call sites gained an argument because the
  contract changed — `deleteLabel({ labelId: 'L1' })` → `+ confirm: true`, and the
  "falls back to the mailto unsubscribe" test → `+ confirm: true`. No assertion in either
  test was changed or removed.

### G2 — image attachments returned as MCP image content blocks — DONE
- Commit: `5e3f867`
- FAIL-before: `npx vitest run src/tools/get-attachment.test.ts` → **10 failed (10)**
  (the module exported neither `attachmentContentBlocks` nor `isViewableImage`).
- PASS-after: full suite **597 passed (597)**, 14 files, typecheck clean.
- What changed: new pure `attachmentContentBlocks(result)` in `src/tools/get-attachment.ts`
  decides the content array; the handler just calls it.
  - A PNG/JPEG/GIF/WebP fetched **without** `save_dir` now returns a real
    `{ type: 'image' }` block, so the model can see the picture.
  - The JSON metadata block is kept alongside it, minus `data_base64` (the bytes are
    already in the image block; repeating them would double the cost of every image
    read) and plus a `returned_as` line saying where they went.
  - Deliberate **whitelist**, not `image/*`: SVG is a script vector and TIFF/HEIC are not
    required to render, so those keep the old base64 behaviour rather than risking the
    whole tool call being rejected. Mime type is matched case-insensitively and with
    parameters stripped (`image/jpeg; name="scan.jpg"`).
  - Size cap honored twice: `getAttachment` still refuses >1MB inline, and the block
    builder independently refuses to build an image block above the cap.
  - `save_dir` reads are unchanged (bytes went to disk; no image block is fabricated),
    and non-image attachments are byte-for-byte the same response as before.

### G3 — scope-error honesty extended to the four read-only tools — DONE
- Commit: `ee5f2b6`
- FAIL-before: `npx vitest run src/tools/read-only-tools.test.ts` → **12 failed | 4 passed
  (16)**. The four that passed are the 401 pass-throughs, which were already correct.
- PASS-after: full suite **613 passed (613)**, 15 files, typecheck clean. The 49 existing
  Calendar tests stayed green through the refactor below, unmodified.
- **Structural choice (worth the reviewer's attention):** rather than copy
  `translateCalendarError` into four more tools, its body was lifted into a new shared
  module `src/google-api-error.ts` (`translateGoogleApiError` + `googleApiCall`), with the
  service's human name as one more context field. `translateCalendarError` is now a
  one-line delegation that fixes `api: 'Google Calendar'`, so its call sites and its tests
  are untouched and no call site can mislabel the API. Layering is
  `google-api-error.ts → gmail/client.ts → scope-error.ts`; `scope-error.ts` still imports
  nothing, so no cycle was introduced.
- The four tools (`list_chat_spaces`, `list_chat_messages`, `search_drive_files`,
  `get_google_doc`) now run their API calls through `googleApiCall` with a context naming
  the tool, the API and the scope that call actually needs. New exported scope constants:
  `CHAT_SPACES_SCOPE`, `CHAT_MESSAGES_SCOPE` (chat/client.ts), `DRIVE_READONLY_SCOPE`
  (drive/client.ts), `DOCS_READONLY_SCOPE` (docs/client.ts) — matching the existing
  `DRIVE_FILE_SCOPE`/`CALENDAR_*_SCOPE` idiom.
- Behaviour per tool: missing scope → names the scope + `npm run auth -- <alias>`;
  disabled API → says to enable it in the Cloud console and that re-authenticating will not
  help; any other 403 → restated with Google's own words and no re-auth advice; rate-limit
  403 → untouched so `withRetry` still retries it; **401 → untouched**, because there
  re-authenticating really is the fix.
