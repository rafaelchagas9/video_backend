# Artwork API — backend contract

**Status:** proposed, not implemented. Written for the frontend redesign so both
sides can be built in parallel.

**Audience:** whoever implements the Kura backend (separate repo).

**Rule that governs everything below:** every field is optional from the
frontend's point of view. The web app must render a complete, good-looking page
for a video that has *nothing* but today's `thumbnail_url`. Artwork is an
enhancement layer, never a dependency. Ship it one variant at a time if you
like — the UI lights up progressively.

---

## 1. Why this exists

Today a video has a flat list of `Thumbnail` rows (`packages/types/src/media.ts`):
a frame grab at a timestamp, with width/height and nothing else. That's enough to
fill a 16:9 box and nothing more.

The redesign needs art that can carry a layout: portrait posters, ultra-wide
hero backdrops, art that knows where the faces are so text doesn't cover them,
and a colour sampled from the art so each title can tint its own surroundings.
None of that can be derived client-side without downloading full frames and
burning CPU on every card in a 60-card grid.

So: **the backend derives art; the frontend composes with it.** The split is
deliberate — anything that requires decoding pixels belongs on the server, and
anything that's a styling decision stays in CSS where it can be changed without
a redeploy.

---

## 2. The core resource

A new `artwork` resource, sitting alongside `thumbnails` rather than replacing
it. Existing thumbnail endpoints keep working untouched.

```ts
export type ArtworkVariant =
  | 'card'      //  16:9  — grid cards, shelves. 640×360 @1x
  | 'poster'    //   2:3  — portrait posters. 400×600 @1x
  | 'square'    //   1:1  — compact shelves, mobile. 400×400 @1x
  | 'hero'      // 21:9   — page-top backdrops. 2560×1097 @1x
  | 'title'     // transparent PNG — baked title lettering, no background

export type ArtworkStatus = 'ready' | 'generating' | 'failed' | 'absent'

export interface ArtworkAsset {
  id: number
  video_id: number
  variant: ArtworkVariant
  url: string                    // content-hashed, immutably cacheable
  width: number
  height: number
  file_size_bytes: number

  /** Source frame this was derived from. Null for 'title'. */
  source_timestamp_seconds: number | null

  /**
   * Crop taken from the source frame, normalized 0–1 relative to the frame.
   * Lets the UI reason about how aggressive the crop was. Null for 'title'.
   */
  crop: { x: number; y: number; width: number; height: number } | null

  /**
   * Normalized 0–1 point of primary interest (usually the largest confident
   * face, else the salience peak). The UI uses this for `object-position`
   * when it has to re-crop the asset to an aspect it wasn't cut for.
   */
  focal_point: { x: number; y: number } | null

  /**
   * Largest rect (normalized 0–1) containing no faces and no high-frequency
   * detail — where text can land without fighting the image. This is the single
   * most valuable field in the payload for text-over-art layouts.
   */
  safe_area: { x: number; y: number; width: number; height: number } | null

  /** Perceived brightness 0–1 of the bottom third. Drives scrim strength. */
  bottom_luma: number | null

  /** Compact placeholder for progressive load. ThumbHash preferred (smaller). */
  thumbhash: string | null

  /** Which post-processing was baked in. See §5. */
  effects: ArtworkEffect[]

  generated_at: IsoDateString
}

export type ArtworkEffect = 'scrim' | 'grain' | 'vignette' | 'title'
```

### Colour

Sampled once per video from the `card` variant, not per variant — one video has
one identity colour, and it must not shift as the user moves between pages.

```ts
export interface ArtworkPalette {
  /** Most visually dominant colour, unmodified. sRGB hex. */
  dominant: string
  /** 3–5 supporting swatches, ordered by coverage descending. sRGB hex. */
  swatches: string[]
  /** Mean OKLCH of the whole image — useful when `dominant` is an outlier. */
  mean_oklch: { l: number; c: number; h: number }
  /** True if the frame is essentially monochrome (mean chroma < 0.03). */
  is_neutral: boolean
}
```

**Send raw values. Do not pre-condition them for the UI.** The frontend clamps
lightness and chroma into a band that keeps the interface coherent (this is the
"noticeable but not crazy" dial), and that band will be tuned repeatedly during
the redesign. If you bake the clamp into the backend, every tweak becomes a
backend deploy. `is_neutral` is the one hint worth computing server-side,
because it's cheap for you and expensive for us.

### The per-video set

```ts
export interface VideoArtwork {
  video_id: number
  status: ArtworkStatus
  palette: ArtworkPalette | null
  assets: ArtworkAsset[]
  /** Present when status === 'failed'. */
  error: string | null
  generated_at: IsoDateString | null
}
```

---

## 3. Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/videos/:id/artwork` | Full `VideoArtwork` for one video |
| `POST` | `/videos/:id/artwork` | Generate / regenerate (async, 202) |
| `DELETE` | `/videos/:id/artwork` | Drop all derived art for a video |
| `GET` | `/artwork/:id/image` | Serve one asset |
| `POST` | `/artwork/batch` | Generate for many videos (async, 202) |

All JSON responses use the existing `ApiSuccessResponse<T>` envelope.

### `POST /videos/:id/artwork`

```ts
export interface GenerateArtworkPayload {
  /** Omit to generate every variant. */
  variants?: ArtworkVariant[]
  /** Re-derive even if fresh art exists. Default false. */
  force?: boolean
  /** Override automatic frame selection. */
  timestamp_seconds?: number
  /** Override baked effects per §5. Omit for the defaults. */
  effects?: ArtworkEffect[]
}
```

Returns `202` with the current `VideoArtwork` (status `generating`). Progress
arrives over SSE.

### `GET /artwork/:id/image`

Query params: `?w=<int>` (resize on the long edge, cap at the stored size —
never upscale) and `?format=webp|avif|jpg|png`.

Content negotiation via `Accept` is fine as the default; the explicit param
exists so the design lab can force a format when comparing.

**Caching matters more than usual here.** A grid pulls 60+ images per scroll.
Please:

- put a content hash in the URL path or as an immutable query key
- `Cache-Control: public, max-age=31536000, immutable`
- serve `ETag` and honour `If-None-Match`
- when art is regenerated, mint a **new** URL rather than mutating the old one

That last point is what lets the frontend cache aggressively without ever
showing stale art.

### `POST /artwork/batch`

```ts
export interface BatchGenerateArtworkPayload {
  video_ids?: number[]
  /** Or select by filter — reuse the existing video list filter shape. */
  filter?: { collection_id?: number; creator_id?: number; missing_only?: boolean }
  variants?: ArtworkVariant[]
  force?: boolean
}
```

`missing_only: true` is the one I'll lean on to backfill a library without
re-doing work.

---

## 4. Embedding in list responses (required — this one is load-bearing)

The grid cannot make one artwork request per card. Video list and detail
endpoints need to carry a compact artwork summary inline, gated behind the
existing `include` mechanism (`VideoListInclude` / `VideoDetailInclude` in
`packages/types/src/video-collections.ts`).

Add `'artwork'` as an include value. When requested, each video in the response
carries:

```ts
export interface VideoArtworkSummary {
  /** URL per available variant. Absent keys mean "not generated". */
  urls: Partial<Record<ArtworkVariant, string>>
  palette: ArtworkPalette | null
  focal_point: { x: number; y: number } | null
  safe_area: { x: number; y: number; width: number; height: number } | null
  bottom_luma: number | null
  thumbhash: string | null
}
```

added to `Video` and `LightweightVideo` as `artwork?: VideoArtworkSummary | null`.

Keep it this small. It's multiplied by the page size on every list request, so
the full `ArtworkAsset` rows have no business being in there — the design lab
pulls those from `/videos/:id/artwork` only when it needs to inspect one.

---

## 5. How the art gets made

This section is intent, not prescription — implement it however is practical.
What the frontend depends on is the *shape* of the output, not your method.

### Frame selection

You already have two signals worth exploiting: the storyboard sprite sheet
(`storyboardRoutes`) gives cheap access to N evenly-spaced frames without
re-decoding the video, and face detections (`faceRoutes.videoFaces`) give you
the subject.

Suggested ranking over storyboard tiles:

1. **Exclude** the first 3% and last 3% of duration — intros, logos, credits.
2. **Exclude** near-black and near-uniform frames (fades, letterbox-only, slates).
   A luma variance floor handles most of it.
3. **Prefer** frames containing a confident, reasonably large, front-facing
   detection. Face area between roughly 4% and 35% of the frame is the sweet
   spot; a face filling the frame crops badly into a poster.
4. **Otherwise** score on sharpness (Laplacian variance), contrast, and
   colourfulness, and take the peak.

Frames chosen this way beat a fixed-timestamp grab by a wide margin, and it's
the difference between a grid that looks curated and one that looks like a file
browser.

### Trimming bars off the source frame

**Implemented.** Before any variant geometry is computed, the extracted frame is
reduced to its content box — the frame minus any letterbox or pillarbox bands.

This is not cosmetic. A 2.39:1 trailer mastered into a 16:9 container has black
bands baked into every frame. Cropping a 2:3 poster out of that takes a
full-height column, so the bands come with it and the poster renders as a 16:9
pillar floating in black. All four raster variants are cut from the same content
box, so they can't disagree with each other.

Detection is deliberately conservative, because over-trimming a genuinely dark
frame is far worse than leaving bars on:

- A row or column counts as a band only if its **brightest** pixel is still
  essentially black. A mean would average a dim shot down into "bar" territory.
- **Opposing bands must be symmetric** (within 25%). This is the load-bearing
  rule. Padding is always centred by the encoder; a dark *region* of a real
  photograph sits wherever the composition put it. Without this check, a dark
  frame gets cropped down to a small bright patch.
- No band may remove more than a third of a dimension, and the result must keep
  at least half of each dimension, or the trim is discarded entirely.

On a 44-frame sample the detector trimmed 14 — every 4:3 thumbnail with 16:9 or
2.39:1 content inside it — and left every native 16:9 frame untouched.

The published `crop` rect stays normalised against the **original** frame, not
the content box, so it remains a truthful description of where the art came from.

Artwork generated before this existed still carries bars. See
`scripts/backfill-artwork-letterbox.ts`, which re-extracts each stored source
frame, runs the same detector, and queues regeneration only for the videos that
actually need it.

### Cropping to each aspect

- Anchor on `focal_point`. For `poster` specifically, place the face on the
  **upper third**, not the centre — that's the film-poster convention and it
  leaves the lower half free for the title.
- Never letterbox or pillarbox to reach an aspect. Crop, or skip the variant.
- If the source is lower resolution than the target, generate at source
  resolution and report the true `width`/`height`. The frontend scales; it just
  needs honest numbers.

### Baked effects

Defaults per variant:

| Variant | Default effects |
|---|---|
| `card` | none |
| `poster` | `scrim`, `grain` |
| `square` | `scrim` |
| `hero` | `grain`, `vignette` |
| `title` | n/a |

- **`scrim`** — bottom-up transparent-to-black gradient, roughly the bottom 45%,
  eased (not linear). Bake it *only* into variants that always show text.
  For `card` and `hero` the frontend does the scrim in CSS, because it needs to
  animate on hover and a baked one can't.
- **`grain`** — fine monochrome noise, low opacity. This is the cheapest thing on
  the list and it does a disproportionate amount of work: it kills gradient
  banding on the dark warm surfaces and makes upscaled frames read as
  intentional rather than soft.
- **`vignette`** — very subtle, corners only.

Keep all three restrained. Anything I can see and name individually is too
strong; they should only be noticeable when toggled off.

### Title treatments (`title` variant)

Transparent PNG containing only the video's title, set in the display face,
which the frontend composites over `hero` and `poster`.

- Typeset the title with automatic size fitting: **max 2 lines**, break on word
  boundaries, tighten tracking as size grows. Three lines was tried and reverted:
  at hero scale a three-line treatment stops being a title and becomes a wall of
  text that swallows the art it is supposed to sit on.
- Trim to the ink bounds and report the true `width`/`height`. No padding — the
  frontend positions it, and baked padding makes that impossible to do precisely.
- Render at 3x the nominal size so it stays crisp when scaled up.
- Pure white (`#ffffff`), full opacity, no shadow or glow baked in. The frontend
  applies colour and shadow in CSS so it can adapt to what's behind it.
- Skip generation when the title is longer than ~40 characters — long titles
  don't work as lettering, and the live-HTML fallback handles them better.

The title face is **configuration, not code** — `ARTWORK_TITLE_FONT_PATH`,
`ARTWORK_TITLE_FONT_FAMILY` and their `_FALLBACK_` counterparts. A baked title in
the wrong family is worse than no baked title at all, so realigning with the
clients' display pairing must not require a code change.

Currently Figtree at `wght=560`, with Archivo (`wght=400`) as the fallback, to
match the clients' "Broadcast" pairing. 560 is pinned to exactly the weight the
live HTML treatment uses, so the baked and live paths are interchangeable — the
frontend falls back to live text for long titles and small slots, and the swap
must not shift the page.

All faces are local static instances, so rendering never depends on a network
font request or on what is installed on the host. **Changing the face requires
regenerating every existing title asset**, since they are baked.

---

## 6. Progress over SSE

Extend `SseEventType` in `packages/types/src/events.ts`:

```ts
| 'artwork:generating'
| 'artwork:ready'
| 'artwork:error'
```

Message payload extends the existing `SseVideoContext` (so `videoId` plus the
snake_case aliases already handled there):

```ts
export interface ArtworkEventMessage extends SseVideoContext {
  variants?: ArtworkVariant[]
  /** 0–100, batch-level. Omit for single-video jobs. */
  progress?: number
  error?: string
}
```

This mirrors `storyboard:generating` / `storyboard:ready` / `storyboard:error`
exactly, so it drops into the existing notification mapping in
`packages/domain/src/sse-notifications.ts` with no new machinery.

---

## 7. Creators and collections

Same shape, lower priority — do videos first and let me confirm the design
holds before spending effort here.

| Method | Path |
|---|---|
| `GET` / `POST` | `/creators/:id/artwork` |
| `GET` / `POST` | `/collections/:id/artwork` |

**Creators** need `square` (the directory cards you already have), `poster`, and
`hero`. Source the art from confirmed face detections across that creator's
videos, preferring high-confidence, well-lit, front-facing frames. A creator
`hero` composed from their best frame is what makes a creator page feel like a
destination rather than a filtered list.

**Collections** need `card` and `hero`. Compose from the member videos' art —
either the strongest single frame or a deliberate 3-up mosaic. If the mosaic is
significant work, ship the single frame and we'll evaluate whether the mosaic
earns its cost.

---

## 8. Storyboards — one small ask

Hover-scrub preview in the grid is built on the existing storyboard sprites, so
no new endpoint is needed. But the current default tile size is tuned for the
player's scrub bar, which is much smaller than a grid card.

If it's cheap: accept `tileWidth` around 320px on `CreateStoryboardPayload`
(already in the type) and let me request a larger sheet for videos that need it.
If it's not cheap, leave it — I'll scale the existing tiles up and lean on the
grain to hide the softness. Not a blocker either way.

---

## 9. Suggested build order

Each step is independently useful and unblocks visible frontend work:

1. **`card` + `poster` + palette + `focal_point`.** Unblocks the entire browse
   grid, which is the largest surface and the one carrying the most variations.
2. **`include=artwork` on video list endpoints (§4).** Without this the grid
   can't use any of step 1 at realistic scale.
3. **`hero` + `safe_area` + `bottom_luma`.** Unblocks detail pages and the
   ambient hero treatment.
4. **SSE events (§6).** Quality-of-life; the frontend polls until it exists.
5. **`square`**, then **creator artwork**.
6. **`title`** — last, once the typography decision is settled.

Steps 1 and 2 together are the point where the redesign stops being a mock and
starts being the real thing. Everything after is refinement.
