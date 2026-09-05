# Collection and artwork follow-ups

The original frontend request's watch counts, runtimes, resume positions, member
watch state, and selectable delegated artwork are implemented. Their contracts
are in the [collection types](../src/modules/video-collections/video-collections.types.ts)
and [playlist types](../src/modules/playlists/playlists.types.ts). Demo state is
SQLite-backed; the former JSON-seeding instructions no longer apply.

The following requests remain undecided or unimplemented:

- Collection credits: decide whether a distinct credits relation is useful or
  whether the client should show the union of member-video creators. Do not
  display invented cast members.
- Collection detail with `include=entries`: currently entries use a separate
  endpoint. The existing detail include accepts artwork only.
- Search/filter/sort on collection and playlist list endpoints. Cross-entity
  search exists, but does not replace list filtering and pagination decisions.
- Composed collection artwork, such as a member mosaic, and dedicated creator
  artwork derived from confirmed face detections. Collections/playlists currently
  delegate to a member video; no separate creator artwork resource exists.
- Uploaded covers were explicitly deferred from the original request.

These are optional follow-ups, not blockers for the existing entity pages or
promises of supported API fields. Re-evaluate the consumer before implementing.
