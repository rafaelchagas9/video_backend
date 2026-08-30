export type DemoRouteSupport = "allowed" | "blocked" | "conditional";

export type DemoRouteScenario = {
  operationKey: string;
  method: string;
  path: string;
  support: DemoRouteSupport;
  verification: "policy-only" | "http-contract";
};

/**
 * Deliberate inventory of every primary operation advertised by Fastify's
 * OpenAPI document. This is intentionally not generated from the policy: a new
 * route must be reviewed and added here before the inventory test will pass.
 *
 * An optional fourth `http-contract` token records operations promoted after a
 * valid request and response/side-effect assertion was audited. Older contract
 * suites remain listed in `HTTP_CONTRACT_OPERATIONS` below.
 */
const MANIFEST_SOURCE = String.raw`
allowed GET /health
allowed POST /api/auth/register
allowed POST /api/auth/login
allowed POST /api/auth/logout
allowed GET /api/auth/me
allowed GET /api/search/
allowed GET /api/directories/ http-contract
allowed POST /api/directories/ http-contract
allowed GET /api/directories/{id} http-contract
allowed PATCH /api/directories/{id} http-contract
allowed DELETE /api/directories/{id} http-contract
allowed POST /api/directories/{id}/scan http-contract
allowed GET /api/directories/{id}/scans http-contract
allowed GET /api/directories/{id}/scans/{scanId} http-contract
allowed GET /api/directories/scheduler/status http-contract
allowed GET /api/directories/{id}/stats http-contract
allowed GET /api/videos/
allowed GET /api/videos/compression-suggestions
allowed GET /api/videos/next
allowed GET /api/videos/triage-queue
allowed POST /api/videos/bulk/delete http-contract
allowed GET /api/videos/unavailable
allowed POST /api/videos/unavailable/verify http-contract
allowed POST /api/videos/unavailable/cleanup http-contract
allowed POST /api/videos/bulk/creators http-contract
allowed POST /api/videos/bulk/tags http-contract
allowed POST /api/videos/bulk/studios http-contract
allowed POST /api/videos/bulk/favorites http-contract
allowed POST /api/videos/bulk/conditional-apply http-contract
allowed GET /api/videos/random
allowed GET /api/videos/duplicates http-contract
allowed GET /api/videos/{id}/related
allowed GET /api/videos/{id}
allowed PATCH /api/videos/{id}
allowed DELETE /api/videos/{id}
allowed POST /api/videos/{id}/verify http-contract
allowed POST /api/videos/{id}/refresh http-contract
allowed GET /api/videos/{id}/stream
allowed GET /api/cleanup/overview http-contract
allowed GET /api/cleanup/candidates http-contract
allowed PUT /api/cleanup/reviews/{videoId} http-contract
allowed POST /api/videos/{id}/cast-sessions
allowed GET /api/videos/{id}/cast-sessions/{sessionId}
allowed DELETE /api/videos/{id}/cast-sessions/{sessionId}
allowed GET /api/cast/{token}/{asset}
allowed GET /api/videos/{id}/creators
allowed POST /api/videos/{id}/creators http-contract
allowed DELETE /api/videos/{id}/creators/{creator_id} http-contract
allowed GET /api/videos/{id}/tags
allowed POST /api/videos/{id}/tags http-contract
allowed DELETE /api/videos/{id}/tags/{tag_id} http-contract
allowed GET /api/videos/{id}/metadata http-contract
allowed POST /api/videos/{id}/metadata http-contract
allowed DELETE /api/videos/{id}/metadata/{key} http-contract
allowed GET /api/videos/{id}/ratings
allowed POST /api/videos/{id}/ratings
allowed GET /api/videos/{id}/bookmarks
allowed POST /api/videos/{id}/bookmarks
allowed POST /api/videos/{id}/analyses/nudity http-contract
allowed GET /api/content-analysis/jobs/{id} http-contract
allowed DELETE /api/content-analysis/jobs/{id} http-contract
allowed GET /api/bookmark-categories/
allowed POST /api/bookmark-categories/ http-contract
allowed PATCH /api/bookmark-categories/{id} http-contract
allowed DELETE /api/bookmark-categories/{id} http-contract
allowed GET /api/videos/{id}/studios
allowed PATCH /api/videos/{id}/studio-assignment http-contract
allowed POST /api/videos/{id}/studios/{studio_id} http-contract
allowed DELETE /api/videos/{id}/studios/{studio_id} http-contract
allowed GET /api/creators/
allowed POST /api/creators/
allowed GET /api/creators/{id}
allowed PATCH /api/creators/{id}
allowed DELETE /api/creators/{id}
allowed POST /api/creators/{id}/merge http-contract
allowed POST /api/creators/bulk http-contract
allowed POST /api/creators/{id}/favorite
allowed DELETE /api/creators/{id}/favorite
allowed GET /api/creators/{id}/favorite/check
allowed GET /api/creators/{id}/videos
allowed GET /api/creators/{id}/picture
allowed POST /api/creators/{id}/picture http-contract
allowed DELETE /api/creators/{id}/picture http-contract
allowed GET /api/creators/{id}/platforms
allowed POST /api/creators/{id}/platforms http-contract
allowed PATCH /api/creators/{id}/platforms/{platformId} http-contract
allowed DELETE /api/creators/{id}/platforms/{platformId} http-contract
allowed GET /api/creators/{id}/social-links
allowed POST /api/creators/{id}/social-links http-contract
allowed POST /api/creators/{id}/platforms/bulk http-contract
allowed POST /api/creators/{id}/social-links/bulk http-contract
allowed POST /api/creators/{id}/picture-from-url http-contract
allowed GET /api/creators/{id}/gallery
allowed POST /api/creators/{id}/gallery http-contract
allowed POST /api/creators/{id}/gallery-from-url http-contract
allowed GET /api/creators/{id}/gallery/{mediaId}/image
allowed PATCH /api/creators/{id}/gallery/{mediaId} http-contract
allowed DELETE /api/creators/{id}/gallery/{mediaId} http-contract
allowed PATCH /api/creators/{id}/social-links/{linkId} http-contract
allowed DELETE /api/creators/{id}/social-links/{linkId} http-contract
allowed GET /api/creators/{id}/aliases
allowed POST /api/creators/{id}/aliases http-contract
allowed POST /api/creators/{id}/aliases/bulk http-contract
allowed PATCH /api/creators/{id}/aliases/{aliasId} http-contract
allowed DELETE /api/creators/{id}/aliases/{aliasId} http-contract
allowed POST /api/creators/{id}/studios/{studioId} http-contract
allowed DELETE /api/creators/{id}/studios/{studioId} http-contract
allowed GET /api/creators/{id}/studios http-contract
allowed GET /api/creators/autocomplete
allowed GET /api/creators/recent
allowed POST /api/creators/quick-create
allowed GET /api/studios/
allowed POST /api/studios/
allowed GET /api/studios/{id}
allowed PATCH /api/studios/{id}
allowed DELETE /api/studios/{id}
allowed POST /api/studios/bulk http-contract
allowed GET /api/studios/{id}/picture
allowed POST /api/studios/{id}/picture http-contract
allowed DELETE /api/studios/{id}/picture http-contract
allowed GET /api/studios/{id}/social-links
allowed POST /api/studios/{id}/social-links http-contract
allowed POST /api/studios/{id}/social-links/bulk http-contract
allowed POST /api/studios/{id}/picture-from-url http-contract
allowed PATCH /api/studios/{id}/social-links/{linkId} http-contract
allowed DELETE /api/studios/{id}/social-links/{linkId} http-contract
allowed POST /api/studios/{id}/creators/bulk http-contract
allowed POST /api/studios/{id}/creators/{creatorId} http-contract
allowed DELETE /api/studios/{id}/creators/{creatorId} http-contract
allowed GET /api/studios/{id}/creators http-contract
allowed POST /api/studios/{id}/videos/{videoId} http-contract
allowed DELETE /api/studios/{id}/videos/{videoId} http-contract
allowed GET /api/studios/{id}/videos
allowed GET /api/studios/autocomplete
allowed GET /api/studios/recent
allowed POST /api/studios/quick-create
allowed GET /api/tags/
allowed POST /api/tags/
allowed GET /api/tags/categories
allowed GET /api/tags/{id}
allowed PATCH /api/tags/{id}
allowed DELETE /api/tags/{id}
allowed GET /api/tags/{id}/children
allowed GET /api/tags/{id}/videos
allowed PATCH /api/ratings/{id}
allowed DELETE /api/ratings/{id}
allowed GET /api/videos/{id}/thumbnails
allowed POST /api/videos/{id}/thumbnails http-contract
allowed GET /api/thumbnails/{id}
allowed DELETE /api/thumbnails/{id} http-contract
allowed GET /api/thumbnails/{id}/image
allowed GET /api/videos/{id}/artwork
allowed POST /api/videos/{id}/artwork http-contract
allowed DELETE /api/videos/{id}/artwork http-contract
allowed POST /api/artwork/batch http-contract
allowed GET /api/artwork/{id}/image
allowed GET /api/playlists/
allowed POST /api/playlists/
allowed GET /api/playlists/{id}
allowed PATCH /api/playlists/{id}
allowed DELETE /api/playlists/{id}
allowed GET /api/playlists/{id}/videos
allowed POST /api/playlists/{id}/videos
allowed POST /api/playlists/{id}/videos/bulk
allowed DELETE /api/playlists/{id}/videos/{video_id}
allowed PATCH /api/playlists/{id}/videos/reorder
allowed GET /api/video-collections/
allowed POST /api/video-collections/
allowed GET /api/video-collections/{id}
allowed PATCH /api/video-collections/{id}
allowed DELETE /api/video-collections/{id}
allowed GET /api/video-collections/{id}/entries
allowed POST /api/video-collections/{id}/entries
allowed PATCH /api/video-collections/{id}/entries/reorder
allowed DELETE /api/video-collections/{id}/entries/{video_id}
allowed GET /api/favorites/
allowed POST /api/favorites/
allowed DELETE /api/favorites/{video_id}
allowed GET /api/favorites/{video_id}/check
allowed PATCH /api/bookmarks/{id}
allowed DELETE /api/bookmarks/{id}
allowed GET /api/backup/ http-contract
allowed POST /api/backup/ http-contract
allowed GET /api/backup/export http-contract
allowed POST /api/backup/{filename}/restore http-contract
allowed DELETE /api/backup/{filename} http-contract
allowed GET /api/videos/{id}/conversions
allowed POST /api/videos/{id}/conversions
allowed POST /api/videos/{id}/convert
allowed POST /api/videos/convert/bulk
allowed GET /api/videos/convert/queue
allowed POST /api/conversions/
allowed GET /api/conversions/queue
allowed GET /api/conversions/history
allowed GET /api/conversions/history/overview
allowed GET /api/conversions/history/insights
allowed GET /api/conversions/history/facets
allowed GET /api/conversions/{id}
allowed PATCH /api/conversions/{id}
allowed DELETE /api/conversions/{id}
allowed POST /api/conversions/{id}/cancel
allowed GET /api/conversions/{id}/download
allowed GET /api/conversions/active
allowed POST /api/conversions/queue/clear
allowed GET /api/conversions/queue/status
allowed GET /api/conversions/status
allowed GET /api/conversion/status
allowed GET /api/conversions/presets/
allowed GET /api/presets/
allowed GET /api/triage/progress http-contract
allowed POST /api/triage/progress http-contract
allowed POST /api/triage/bulk-actions http-contract
allowed GET /api/triage/stats http-contract
allowed GET /api/users/triage-progress http-contract
allowed POST /api/users/triage-progress http-contract
allowed POST /api/users/triage/bulk-actions http-contract
allowed GET /api/users/triage/statistics http-contract
allowed GET /api/videos/history
allowed POST /api/videos/{id}/watch
allowed GET /api/videos/{id}/stats
allowed GET /api/settings/
allowed PATCH /api/settings/
allowed GET /api/videos/{id}/thumbnails.vtt
allowed GET /api/videos/{id}/storyboard.jpg
allowed GET /api/videos/{id}/storyboard.webp
allowed GET /api/videos/{id}/storyboard
allowed POST /api/videos/{id}/storyboard http-contract
allowed DELETE /api/videos/{id}/storyboard http-contract
allowed GET /api/stats/storage
allowed GET /api/stats/storage/history
allowed POST /api/stats/storage-snapshots
allowed GET /api/stats/library
allowed GET /api/stats/library/history
allowed POST /api/stats/library-snapshots
allowed GET /api/stats/content
allowed GET /api/stats/content/history
allowed POST /api/stats/content-snapshots
allowed GET /api/stats/usage
allowed GET /api/stats/usage/history
allowed POST /api/stats/usage-snapshots
allowed POST /api/stats/snapshots
allowed POST /api/stats/storage/snapshot
allowed POST /api/stats/library/snapshot
allowed POST /api/stats/content/snapshot
allowed POST /api/stats/usage/snapshot
allowed POST /api/stats/snapshot
allowed GET /api/events/stream
allowed GET /api/tagging-rules/ http-contract
allowed POST /api/tagging-rules/ http-contract
allowed GET /api/tagging-rules/{id} http-contract
allowed PATCH /api/tagging-rules/{id} http-contract
allowed DELETE /api/tagging-rules/{id} http-contract
allowed POST /api/tagging-rules/bulk/delete http-contract
allowed POST /api/tagging-rules/{id}/test http-contract
allowed POST /api/tagging-rules/apply http-contract
allowed GET /api/faces/health http-contract
allowed GET /api/creators/{id}/face-embeddings
allowed POST /api/creators/{id}/face-embeddings http-contract
allowed POST /api/creators/{id}/face-embeddings/base64 http-contract
allowed POST /api/creators/{id}/face-embeddings/from-gallery/{mediaId} http-contract
allowed PUT /api/creators/{id}/face-embeddings/{eid}/primary http-contract
allowed DELETE /api/creators/{id}/face-embeddings/{eid} http-contract
allowed GET /api/creators/{id}/face-embeddings/{eid}/thumbnail
allowed GET /api/videos/{id}/faces http-contract
allowed GET /api/faces/{id}/image http-contract
allowed POST /api/videos/{id}/faces/extract http-contract
allowed PUT /api/videos/{id}/faces/{did}/confirm http-contract
allowed PUT /api/videos/{id}/faces/{did}/reject http-contract
allowed GET /api/creators/{id}/videos-by-face http-contract
allowed POST /api/faces/search http-contract
allowed GET /api/videos/{id}/faces/status http-contract
allowed DELETE /api/faces/queue http-contract
allowed GET /api/videos/{id}/editing-metadata
allowed POST /api/videos/{id}/edits
allowed GET /api/edits/jobs
allowed GET /api/edits/jobs/{id}
allowed POST /api/edits/jobs/{id}/cancel
allowed POST /api/edits/jobs/{id}/clone http-contract
allowed POST /api/multiplayer-remote/display-devices http-contract
allowed POST /api/multiplayer-remote/sessions http-contract
allowed GET /api/multiplayer-remote/sessions/{id} http-contract
allowed POST /api/multiplayer-remote/sessions/{id}/close http-contract
allowed POST /api/multiplayer-remote/pair http-contract
allowed POST /api/multiplayer-remote/trusted-devices/discover http-contract
allowed POST /api/multiplayer-remote/sessions/{id}/trusted-connect http-contract
allowed GET /api/multiplayer-remote/sessions/{id}/join-requests/pending http-contract
allowed POST /api/multiplayer-remote/sessions/{id}/join-requests/{requestId}/approve http-contract
allowed POST /api/multiplayer-remote/sessions/{id}/join-requests/{requestId}/reject http-contract
allowed POST /api/enrichment/{entityType}/{id}/run
allowed GET /api/enrichment/{entityType}/{id}/runs
allowed GET /api/enrichment/suggestions
allowed POST /api/enrichment/suggestions/{id}/accept
allowed POST /api/enrichment/suggestions/{id}/reject
`;

const HTTP_CONTRACT_OPERATIONS = new Set([
  "GET /api/videos/{id}/conversions",
  "POST /api/videos/{id}/conversions",
  "POST /api/videos/{id}/convert",
  "POST /api/videos/convert/bulk",
  "GET /api/videos/convert/queue",
  "POST /api/conversions/",
  "GET /api/conversions/queue",
  "GET /api/conversions/{id}",
  "PATCH /api/conversions/{id}",
  "DELETE /api/conversions/{id}",
  "POST /api/conversions/{id}/cancel",
  "GET /api/conversions/{id}/download",
  "GET /api/conversions/active",
  "POST /api/conversions/queue/clear",
  "GET /api/conversions/queue/status",
  "GET /api/conversions/status",
  "GET /api/conversion/status",
  "GET /api/conversions/presets/",
  "GET /api/presets/",
  "GET /api/stats/storage",
  "GET /api/stats/storage/history",
  "POST /api/stats/storage-snapshots",
  "GET /api/stats/library",
  "GET /api/stats/library/history",
  "POST /api/stats/library-snapshots",
  "GET /api/stats/content",
  "GET /api/stats/content/history",
  "POST /api/stats/content-snapshots",
  "GET /api/stats/usage",
  "GET /api/stats/usage/history",
  "POST /api/stats/usage-snapshots",
  "POST /api/stats/snapshots",
  "POST /api/stats/storage/snapshot",
  "POST /api/stats/library/snapshot",
  "POST /api/stats/content/snapshot",
  "POST /api/stats/usage/snapshot",
  "POST /api/stats/snapshot",
  "GET /api/settings/",
  "PATCH /api/settings/",
  "POST /api/enrichment/{entityType}/{id}/run",
  "GET /api/enrichment/{entityType}/{id}/runs",
  "GET /api/enrichment/suggestions",
  "POST /api/enrichment/suggestions/{id}/accept",
  "POST /api/enrichment/suggestions/{id}/reject",
  "GET /api/videos/{id}/editing-metadata",
  "POST /api/videos/{id}/edits",
  "GET /api/edits/jobs",
  "GET /api/edits/jobs/{id}",
  "POST /api/edits/jobs/{id}/cancel",
  "POST /api/edits/jobs/{id}/clone",
]);

export const DEMO_ROUTE_SCENARIOS: DemoRouteScenario[] = MANIFEST_SOURCE.trim()
  .split("\n")
  .map((line) => {
    const [support, method, path, verification] = line.trim().split(/\s+/, 4);
    if (!support || !method || !path) {
      throw new Error(`Invalid demo route manifest line: ${line}`);
    }

    const operationKey = `${method} ${path}`;
    return {
      operationKey,
      method,
      path,
      support: support as DemoRouteSupport,
      verification:
        verification === "http-contract" ||
        HTTP_CONTRACT_OPERATIONS.has(operationKey)
          ? "http-contract"
          : "policy-only",
    };
  });
