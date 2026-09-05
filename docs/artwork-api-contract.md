# Artwork integration

Artwork is implemented. The authoritative API contract is generated at `/docs`
from [artwork routes](../src/modules/artwork/artwork.routes.ts) and
[schemas](../src/modules/artwork/artwork.schemas.ts); shared backend shapes live
in [artwork.types.ts](../src/modules/artwork/artwork.types.ts).

## Client workflow

1. Request `include=artwork` with videos, watch history, collections, or playlists
   to obtain the summary alongside the list row.
2. Use `GET /api/videos/:id/artwork` for the complete asset set and
   `POST /api/videos/:id/artwork` to request asynchronous generation. Batch
   generation is available at `POST /api/artwork/batch`.
3. Use returned asset URLs rather than reconstructing them: their hash identifies
   the stored version and image responses are cached immutably.
4. Handle `artwork:generating`, `artwork:ready`, and `artwork:error` SSE events;
   refetch when an asset set changes.
5. Fall back to the existing thumbnail or live title text when artwork is absent,
   generating, failed, or lacks the requested variant.

The variants are `card`, `poster`, `square`, `hero`, and transparent `title`.
Palette, focal point, safe area, and bottom luminance are rendering hints.
Frontend styling remains responsible for adapting colour and contrast to its
layout. Collections and playlists delegate artwork to a selected member video;
changing `artwork_source_video_id` requires that video to belong to the entity.

## Title assets and regeneration

Titles use local fonts configured with `ARTWORK_TITLE_FONT_PATH`,
`ARTWORK_TITLE_FONT_FAMILY`, and their fallback settings. Font assets and licensing
are described in [assets/fonts/README.md](../assets/fonts/README.md).
Changing a font requires regenerating existing baked title assets.

The [renderer](../src/modules/artwork/artwork.processing.ts) controls dimensions,
effects, bar trimming, line fitting, and the long-title fallback. Keep live client
typography aligned with the configured face; use live text where no title asset
is returned.

Separate creator artwork, uploaded covers, and composed collection mosaics remain
[follow-up decisions](collections-playlists-api-request.md).
