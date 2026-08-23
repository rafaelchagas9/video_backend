# API request — mobile home, search and quick look

**From:** frontend, design-lab surface `Mobile`
**Status:** the surface is built and working against the current API. Nothing
here blocks it. Each ask removes a workaround that is marked in code at the
place it is used.

Context: the Android app is being restructured from
`Videos · Favorites · Library · Settings` to `Home · Library · Search · More`.
Home opens on a full-bleed billboard built from the top continue-watching
entry; Search becomes a destination that searches the taxonomy, not only
filenames; a long-press opens a Quick Look sheet built around identity
(creators, studio, tags) rather than around a synopsis.

Ordered by how much each one is costing us.

---

## §1 — Watch history should carry artwork and creators

`GET /videos/history` serves:

```ts
WatchHistoryVideo = { id, file_name, title, duration_seconds, thumbnail_id, thumbnail_url }
```

The billboard is built from `history[0]`, and it needs the artwork summary —
`hero` variant, palette (for the per-title tint), focal point — plus creators
for the identity line. None of that is on this payload.

**What the phone does today:** fetches `GET /videos/:id?include=creators,tags,studios,artwork`
for the spotlight as a *second* request on every cold launch of Home, and
resolves the Up next rail by cross-referencing history ids against a separately
loaded page of 40 recent videos. Any resumable video older than those 40 is
silently dropped from the rail.

**Ask:** support `include` on `GET /videos/history` with the same values the
video list takes — `artwork`, `creators`, `tags`, `studios` — and return the
same `artwork` summary shape (`urls`, `palette`, `focal_point`, `safe_area`,
`bottom_luma`, `thumbhash`).

```
GET /videos/history?limit=24&page=1&include=artwork,creators
```

This is the one that matters most: it removes a request from the critical path
of the app's first screen and makes Continue Watching correct rather than
best-effort.

---

## §2 — Tag video counts, and sorting tags by them

`Tag` has no count of what is behind it, and `GET /tags` has no
`sort=video_count`. `Creator` and `Studio` both already carry
`linked_video_count`.

Home's "Browse by tag" shelf and Search's tag grid are both entry points — the
useful order for an entry point is "biggest first", and the useful chip says
how much is behind it. Right now both are alphabetical and silent, which makes
a tag chip a guess.

**Ask:**
- `video_count?: number` on tag list rows.
- `sort: 'video_count'` accepted by `GET /tags`.

---

## §3 — Tag colour inside `include=tags`

`video.tags` is `Array<{ id, name }>`. Tags have a `color`, and the Quick Look
sheet shows tag chips in their real colours — that is most of what makes the
tag strip readable at a glance rather than a row of identical grey pills.

**What the phone does today:** loads the first 60 tags from `GET /tags`
separately and builds an id → colour map. A video carrying a tag outside that
page renders it grey.

**Ask:** return `{ id, name, color, parent_id }` for `include=tags` on both
`GET /videos` and `GET /videos/:id`.

---

## §4 — Per-video play count and last-played

The Quick Look facts grid has six cells: runtime, quality, codec, size, added,
and one more. That last one wants to be **Plays** — it is the fact that says
whether this is something you keep coming back to.

`Video` carries neither `play_count` nor `last_played_at`; they exist only
inside the loaded window of `GET /videos/history`.

**What the phone does today:** shows Plays when the video happens to be in the
loaded history page, and falls back to the audio codec when it is not. So the
same sheet shows different facts for different videos, which is not a design,
it is a shrug.

**Ask:** `include=stats` on `GET /videos` and `GET /videos/:id`, adding
`play_count: number` and `last_played_at: IsoDateString | null`.

---

## §5 — A rediscovery filter

`GET /videos/random` takes `maxPlayCount`, so `maxPlayCount: 0` already gives
the "Never watched" shelf, and that shelf is live in the design.

What has no filter behind it is the other one every streaming app has:
**watched once, a long time ago**. That needs "played at least once, but not
recently".

**Ask:** on `GET /videos` and `GET /videos/random`:
- `minPlayCount?: number`
- `lastPlayedBefore?: IsoDateString`
- `lastPlayedAfter?: IsoDateString`

With those, the shelf is `{ minPlayCount: 1, lastPlayedBefore: <six months ago> }`.

---

## §6 — One cross-entity search endpoint (nice to have)

Search currently fans out to three endpoints per debounced keystroke —
`GET /videos?search=`, `GET /creators/autocomplete`, `GET /studios/autocomplete`
— and matches tags client-side against whatever page of the tag directory is
loaded. It works, and on a LAN it is fast enough. It is listed here because the
fan-out is the reason tag matching is capped at the first 60 tags.

**Ask, if it is cheap:**

```
GET /search?q=<term>&limit=<n>
→ { videos: Video[], creators: Creator[], studios: Studio[], tags: Tag[],
    collections: VideoCollection[], playlists: Playlist[],
    totals: { videos: number, creators: number, ... } }
```

Per-group `totals` matter more than the rows: the section heads show counts,
and a count that only reflects the returned page is a lie.

---

## §7 — Inline entity pictures (low priority)

`video.creators` and `video.studios` are `{ id, name }`. The phone builds
`/creators/:id/picture` and `/studios/:id/picture` by hand to render faces on
the billboard and in Quick Look. That is a guess about a route rather than a
contract, and it means the client cannot tell "has no picture" from "picture
failed to load".

**Ask:** include `profile_picture_url: string | null` on those inline records.

---

## Demo mode

All of the above should be reachable in demo mode — the design lab renders
against the demo API, and a route that is `DEMO_MODE_ROUTE_BLOCKED` cannot be
designed against. Follow the pattern used for aliases and enrichment: seed in
`demo_mode/demo_mode.json`, a getter on `DemoMockService`, an `env.DEMO_MODE`
branch that returns *before* any `db` call, and a narrow entry in
`demo-mode-policy.ts`. Read that file's test before widening anything.
