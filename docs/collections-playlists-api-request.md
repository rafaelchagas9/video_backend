# Backend request — collections & playlists

**From:** the web redesign pass on `/design-lab` (Collection page + Playlist page).
**Status:** the frontend is being built now against the current contract and
degrades gracefully on every field below. Nothing here blocks the redesign — it
replaces invented numbers with true ones.

---

## 0. Why this exists

Both surfaces are being rebuilt as full **entity pages**: full-bleed art, a
title, one line of facts, one primary action, then the contents as a flat list.
That shape lives or dies on four facts being *true*:

| The page says | Today it comes from |
|---|---|
| "2 of 5 seen" | `collection.id % 3` — **invented** |
| "16m" total runtime | `(entry.id * 37) % 7200` — **invented** |
| "Resume S1 · E3" | nothing — the button is a no-op label |
| the art behind the title | the *first member video's* hero crop |

Three of the four are fabrications sitting under a heading that reads as fact.
That is the thing worth fixing; the layout work is ours.

Requests are ordered by how much they change the page. **§1 and §2 are the ones
that matter** — §3 onward is nice-to-have and can be dropped without the design
suffering.

---

## 1. Real watch state (highest value)

### 1.1 Collections

`GET /video-collections` — add to each `VideoCollection`:

```jsonc
{
  "entry_count": 5,          // exists today
  "watched_count": 2,        // NEW — entries the user has finished
  "runtime_seconds": 986,    // NEW — sum of member durations, nulls skipped
  "season_count": 1,         // NEW — distinct non-null season_number
  "last_watched_at": "2026-08-19T21:04:00.000Z", // NEW, nullable
  "resume": {                // NEW, nullable — first unfinished entry in canon order
    "entry_id": 12,
    "video_id": 4,
    "season_number": 1,
    "episode_number": 3,
    "position_seconds": 184
  }
}
```

This single object retires the fake status filter (Complete / In progress /
Unseen are currently computed from the row id) **and** makes the primary action
honest: "Start watching" vs "Resume S1 · E3" vs "Watch again".

`GET /video-collections/:id/entries` — add to each entry's embedded `video`:

```jsonc
"video": {
  "id": 4,
  "file_name": "…",
  "title": "…",
  "thumbnail_id": 4,
  "thumbnail_url": "/api/thumbnails/4/image",
  "is_available": true,
  "duration_seconds": 412,     // NEW — the field exists on LightweightVideo, not served here
  "watched": true,             // NEW
  "position_seconds": 0        // NEW — nullable; drives the per-row progress sliver
}
```

### 1.2 Playlists

`GET /playlists` — add to each `Playlist`:

```jsonc
{
  "video_count": 3,          // exists today
  "watched_count": 1,        // NEW
  "runtime_seconds": 742,    // NEW
  "last_played_at": "2026-08-20T18:12:00.000Z", // NEW, nullable
  "resume": { "video_id": 1, "position_seconds": 96 } // NEW, nullable
}
```

`GET /playlists/:id/videos` — each row already carries `duration_seconds`, but
it is `null` for every demo row. Two asks:

- populate `duration_seconds` where the probe knows it;
- add `"watched": bool` and `"position_seconds": number | null`.

---

## 2. Artwork for collections and playlists

Today a collection has **no artwork of its own**. The page borrows its lead
member's `hero` crop, which means two collections sharing a lead video are
indistinguishable, and a collection's identity changes when its first entry is
reordered.

**Ask:** let a collection and a playlist carry the same artwork shape a video
already does, via the include parameter that already exists elsewhere:

```
GET /video-collections?include=artwork
GET /playlists?include=artwork
```

returning the existing `VideoArtworkSummary` shape (`urls` per variant +
`palette` + focal point), so the frontend's `useVideoArtwork` /
`resolveLabArtwork` path works unchanged:

```jsonc
"artwork": {
  "status": "ready",
  "palette": { "dominant": "#…", "swatches": ["#…"], "mean_oklch": {…}, "is_neutral": false },
  "urls": { "card": "…", "poster": "…", "square": "…", "hero": "…", "title": "…" }
}
```

Two acceptable levels of effort, in order of preference:

1. **Composed** — generate the variants for the collection itself (a mosaic of
   member frames, or the best-scoring member frame promoted). This is what makes
   a collection feel like a title rather than a folder.
2. **Delegated** — a `artwork_source_video_id` chosen once and stored, so at
   least the identity is *stable* under reordering, and the user can override it.

Even level 2 is a real improvement. If neither is cheap, say so and we keep
borrowing the lead member — the design already handles it.

A user-settable cover (`PATCH` with an uploaded image) is wanted eventually but
is **not** part of this request.

---

## 3. Collection credits

The Cast section on the collection page is currently a hardcoded array of six
invented names — it exists to prove the layout, and it should not ship that way.

**Ask:** either

- a real credits relation on a collection (`GET /video-collections/:id/credits`
  → `[{ person_id, name, role, picture_url }]`), **or**
- explicit confirmation that collections will never carry credits, in which case
  we delete the section and derive a **Creators** strip from the union of the
  member videos' creators instead — which needs nothing new, since
  `GET /videos?include=creators` already exists.

The second option is genuinely fine and cheaper. We just need to know which,
because "delete the section" and "wire the section" are different work.

---

## 4. Smaller things, in descending value

1. **`GET /video-collections/:id` does not embed entries.** Two round-trips to
   render one page. An `?include=entries` would collapse it. Low priority — the
   queries are parallel already.
2. **No search/filter/sort on `GET /video-collections` or `GET /playlists`.**
   Both are filtered client-side today, which is correct at this library's size
   and wrong at 500 collections. Not needed now; flagging it before it bites.
3. **Playlist reorder is `PATCH /playlists/:id/videos/reorder` with the full
   list.** Fine. Same for collections. No change requested.
4. **`Playlist.thumbnail_url` points at a member's thumbnail row**
   (`/api/thumbnails/3/image`). Superseded by §2 if that lands.

---

## 5. What we are NOT asking for

To be explicit, so nothing is built speculatively:

- No completeness scores, percentages, or health grades. They were rejected on
  the creators pass and they are rejected here.
- No new write endpoints. Create / update / delete / add-entry / reorder all
  exist and are sufficient.
- No changes to demo mode's blocking policy beyond serving the fields above for
  the demo fixtures, so the lab can be judged against realistic values.

---

## 6. Demo-mode note

The lab is judged at `https://video.lan.rafaelm.dev/design-lab` against demo
mode. For any field above, seeding a plausible value in `demo_mode.json` is as
important as serving it in production — a `watched_count` that is always `0` and
a `duration_seconds` that is always `null` leave the design being judged on
placeholder dashes.

Specifically, the demo playlist rows currently return `"duration_seconds": null`
for all seven videos, so every runtime on the playlist page renders as `—`.
