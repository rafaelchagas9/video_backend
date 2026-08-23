# Plan 001: Let users choose the delegated cover source

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report; do not improvise. When done, update this plan's row in
> `plans/README.md`, unless a reviewer says they maintain the index.
>
> **Drift check (run first)**:
> ```bash
> git diff --stat 9a00ff3..HEAD -- src/modules/video-collections src/modules/playlists src/database/demo tests
> git diff --stat -- src/modules/video-collections src/modules/playlists src/database/demo tests
> git -C /home/rafael/Documentos/projetos/kura diff --stat d71a4f0..HEAD -- packages/types packages/validation packages/api apps/web/src/pages/VideoCollectionsPage.tsx apps/web/src/pages/PlaylistsPage.tsx
> git -C /home/rafael/Documentos/projetos/kura diff --stat -- packages/types packages/validation packages/api apps/web/src/pages/VideoCollectionsPage.tsx apps/web/src/pages/PlaylistsPage.tsx
> ```
> This plan was authored against uncommitted collection/playlist work on top of
> backend commit `9a00ff3`. Do not reset, discard, or overwrite that work. If
> the excerpts below no longer match, stop and reconcile with the owner.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: direction
- **Planned at**: backend `9a00ff3` plus the working-tree collection/playlist contracts; Kura `d71a4f0`, 2026-08-23

## Why this matters

Collections and playlists already delegate their artwork to one member and keep
that choice stable across reordering. Today the first member silently becomes
the source, so the user cannot correct an unsuitable cover. This plan exposes
the existing decision without introducing uploads, generated art, or another
artwork model.

## Current state

- `docs/collections-playlists-api-request.md:124-136` explicitly asks for a
  user override while deferring uploaded covers.
- `src/modules/video-collections/video-collections.types.ts:106-115` defines
  `updateVideoCollectionSchema = createVideoCollectionSchema.partial()`; the
  create schema has no `artwork_source_video_id`.
- `src/modules/playlists/playlists.types.ts:33-41` similarly limits updates to
  `name` and `description`.
- `src/modules/video-collections/video-collections.service.ts:362-368` and
  `src/modules/playlists/playlists.service.ts:291-297` assign the first member:
  ```ts
  artworkSourceVideoId: sql`COALESCE(${videoCollectionsTable.artworkSourceVideoId}, ${input.video_id})`
  artworkSourceVideoId: sql`COALESCE(${playlistsTable.artworkSourceVideoId}, ${videoId})`
  ```
- Removal already selects a deterministic remaining member in
  `video-collections.service.ts:487-507` and `playlists.service.ts:328-341`.
- SQLite parity lives in `src/database/demo/repository.ts`:
  `updatePlaylist` around line 724, `updateCollection` around line 938, and the
  source fallback logic around lines 764-785 and 1059-1087.
- Kura already reads `artwork_source_video_id` in
  `packages/types/src/entities.ts` and
  `packages/types/src/video-collections.ts`. Its update validators are
  `packages/validation/src/entities.ts:updatePlaylistSchema` and
  `packages/validation/src/video-collections.ts:updateVideoCollectionSchema`.
  The generic update clients already exist in `packages/api/src/playlists.ts`
  and `packages/api/src/video-collections.ts`.
- The relevant UI entry points are the existing **Edit metadata** actions in
  `apps/web/src/pages/PlaylistsPage.tsx` and
  `apps/web/src/pages/VideoCollectionsPage.tsx`.
- Backend conventions: use Zod schemas, `BadRequestError`/`NotFoundError`,
  `authenticateUser`, and Pino; never `console.log`. No database migration is
  needed because both source columns already exist.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Backend focused tests | `bun test tests/demo-content-sqlite.test.ts tests/demo-mode-route-coverage.test.ts tests/integration/core-crud.integration.test.ts` | all selected tests pass |
| Backend typecheck | `bunx tsc --noEmit` | exit 0, no errors |
| Backend build | `bun run build` | exit 0 |
| Kura typecheck | `pnpm --filter @kura/web typecheck` | exit 0, no errors |
| Kura build | `pnpm --filter @kura/web build` | exit 0 |
| Kura lint | `pnpm --filter @kura/web lint` | exit 0 |

## Scope

**In scope**:

- Backend collection/playlist types, schemas, routes, services, demo adapters,
  and their focused tests.
- Kura collection/playlist types, validation, API query invalidation if needed,
  and both entity pages.

**Out of scope**:

- Uploaded, cropped, composed, or generated artwork.
- Choosing a video that is not already a member.
- An "automatic" nullable mode. Empty entities may remain `null`, but the
  update contract accepts only a positive member ID.
- Any schema migration or change to artwork fallback precedence.

## Git workflow

- Preserve the backend's existing dirty work. Never use `git reset`, checkout
  restoration, or a blanket stash.
- Branches: `codex/001-delegated-covers` in each repository.
- Commit logical units separately in each repository. Match local history, for
  example `feat(collections): allow delegated cover selection`.
- Stage only the intended hunks; do not commit unrelated pre-existing changes.
- Do not push or open a PR unless the operator explicitly asks.

## Steps

### Step 1: Extend and document the update contracts

Add `artwork_source_video_id: z.number().int().positive().optional()` to the
backend update schemas only. Extend the matching Fastify response/request
schemas and the Kura update payload validators/types. Do not add it to create
contracts and do not accept `null`.

Document in the OpenAPI description that the referenced video must already be
a member of the target collection or playlist.

**Verify**: `bunx tsc --noEmit && pnpm --dir /home/rafael/Documentos/projetos/kura --filter @kura/web typecheck` -> both exit 0.

### Step 2: Enforce membership and ownership atomically

In `VideoCollectionsService.update`, when the field is present, query
`video_collection_entries` for the exact `(collection_id, video_id)` pair. In
`PlaylistsService.update`, first retain the current ownership check, then query
`playlist_videos` for `(playlist_id, video_id)`. Reject a non-member with
`BadRequestError("Artwork source video must belong to this collection")` or the
playlist equivalent. Update metadata, source ID, and `updatedAt` in the same
transaction.

Mirror the same rules in SQLite through `src/database/demo/repository.ts` and
the existing demo services. Preserve the current fallback when the chosen
member is later removed and preserve the chosen source across reorder.

**Verify**: `bun test tests/demo-content-sqlite.test.ts tests/integration/core-crud.integration.test.ts` -> new production and demo cases pass.

### Step 3: Add the cover chooser to both Kura entity pages

Use the already-loaded member list in each entity page. Add a **Choose cover**
control beside the current metadata action. Show member thumbnails and titles,
mark the current `artwork_source_video_id`, disable submission when unchanged,
and send the ordinary PATCH update with the selected member ID. On success,
invalidate both the entity detail/list query and its `include=artwork` data so
the header changes immediately.

Use existing dialog, button, media-slot, loading, empty-state, and toast
components from those pages. Hide/disable the action when there are no members.
Do not fetch the full video library for this chooser.

**Verify**: `pnpm --dir /home/rafael/Documentos/projetos/kura --filter @kura/web typecheck && pnpm --dir /home/rafael/Documentos/projetos/kura --filter @kura/web build` -> both exit 0.

### Step 4: Complete regression coverage

Add HTTP and service assertions for collection and playlist happy paths,
non-member rejection, source stability after reorder, fallback after source
removal, empty-entity behavior, playlist ownership, and SQLite demo parity.
Extend Kura's existing collection/playlist E2E coverage if those flows already
have a stable fixture; otherwise add a focused component test only if the repo
has a local precedent. Do not introduce a new test framework.

**Verify**: run the focused commands above, then `bun run test:unit` and
`pnpm --dir /home/rafael/Documentos/projetos/kura lint` -> all pass.

## Test plan

- Model backend cases after the collection/playlist sections in
  `tests/integration/core-crud.integration.test.ts` and SQLite assertions in
  `tests/demo-content-sqlite.test.ts`.
- Cover both entity types with: selected member succeeds; non-member is 400;
  reorder does not change the choice; deleting the source chooses the existing
  deterministic fallback; deleting the final member produces `null`.
- Verify the demo route remains allowed in `tests/demo-mode-policy.test.ts` only
  if a route shape changes; PATCH is already in the allowlist.

## Done criteria

- [ ] Both PATCH contracts accept a positive `artwork_source_video_id`.
- [ ] Both production and demo implementations reject non-members and preserve ownership.
- [ ] Both Kura pages offer a member-only cover chooser and refresh delegated artwork.
- [ ] Reordering does not change a chosen source; removal still falls back deterministically.
- [ ] No migration files were created.
- [ ] Focused tests, backend typecheck/build, and Kura typecheck/build/lint pass.
- [ ] `git status --short` in both repos shows no unrelated new modifications.
- [ ] `plans/README.md` is updated.

## STOP conditions

Stop and report if the current uncommitted collection/playlist contract is
missing, if delegated artwork no longer keys off `artwork_source_video_id`, if
membership can span multiple collections contrary to the current unique rule,
or if implementation appears to require uploaded/composed artwork. Also stop
after two failed verification attempts or if unrelated dirty hunks would be
overwritten.

## Maintenance notes

If uploaded covers are added later, define explicit precedence among uploaded,
generated, and delegated artwork. Reviewers should scrutinize membership checks,
playlist ownership, transaction boundaries, and demo parity.
