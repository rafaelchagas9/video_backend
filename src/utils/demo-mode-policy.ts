import { API_PREFIX } from "@/config/constants";

const READ_ONLY_PUBLIC_PATHS = [/^\/health$/, /^\/docs(?:\/.*)?$/];

const SAFE_API_REQUESTS: Array<{
  methods: ReadonlySet<string>;
  path: RegExp;
}> = [
  {
    methods: new Set(["POST"]),
    path: new RegExp(`^${API_PREFIX}/auth/(?:login|logout|register)$`),
  },
  {
    methods: new Set(["GET"]),
    path: new RegExp(`^${API_PREFIX}/auth/me$`),
  },
  {
    methods: new Set(["PATCH"]),
    path: new RegExp(`^${API_PREFIX}/videos/\\d+/studio-assignment$`),
  },
  {
    methods: new Set(["GET"]),
    path: new RegExp(
      `^${API_PREFIX}/videos(?:/(?:compression-suggestions|next|triage-queue|unavailable|random|history))?$`
    ),
  },
  {
    methods: new Set(["GET", "PATCH", "DELETE"]),
    path: new RegExp(`^${API_PREFIX}/videos/\\d+$`),
  },
  {
    methods: new Set(["GET"]),
    path: new RegExp(
      `^${API_PREFIX}/videos/\\d+/(?:related|stream|creators|tags|studios|ratings|bookmarks|stats|thumbnails|storyboard|conversions|artwork)$`
    ),
  },
  {
    methods: new Set(["POST"]),
    path: new RegExp(`^${API_PREFIX}/videos/\\d+/cast-sessions$`),
  },
  {
    methods: new Set(["GET", "DELETE"]),
    path: new RegExp(`^${API_PREFIX}/videos/\\d+/cast-sessions/[a-f0-9]{64}$`),
  },
  {
    methods: new Set(["GET"]),
    path: new RegExp(
      `^${API_PREFIX}/cast/[a-f0-9]{64}/(?:master\\.m3u8|index\\.m3u8|init\\.mp4|segment-\\d{6}\\.(?:m4s|ts))$`
    ),
  },
  {
    methods: new Set(["GET"]),
    path: new RegExp(
      `^${API_PREFIX}/conversions/(?:active|history(?:/(?:overview|insights|facets))?|queue(?:/status)?|presets)$`
    ),
  },
  {
    methods: new Set(["POST"]),
    path: new RegExp(
      `^${API_PREFIX}/videos/(?:\\d+/(?:conversions|convert)|convert/bulk)$`
    ),
  },
  {
    methods: new Set(["GET"]),
    path: new RegExp(`^${API_PREFIX}/videos/convert/queue$`),
  },
  {
    methods: new Set(["POST"]),
    path: new RegExp(`^${API_PREFIX}/conversions$`),
  },
  {
    methods: new Set(["GET", "PATCH", "DELETE"]),
    path: new RegExp(`^${API_PREFIX}/conversions/\\d+$`),
  },
  {
    methods: new Set(["POST"]),
    path: new RegExp(`^${API_PREFIX}/conversions/\\d+/cancel$`),
  },
  {
    methods: new Set(["GET"]),
    path: new RegExp(`^${API_PREFIX}/conversions/\\d+/download$`),
  },
  {
    methods: new Set(["POST"]),
    path: new RegExp(`^${API_PREFIX}/conversions/queue/clear$`),
  },
  {
    methods: new Set(["GET"]),
    path: new RegExp(
      `^${API_PREFIX}/(?:conversions/status|conversion/status|presets)$`
    ),
  },
  {
    methods: new Set(["GET"]),
    path: new RegExp(
      `^${API_PREFIX}/videos/\\d+/(?:thumbnails\\.vtt|storyboard\\.(?:jpg|webp))$`
    ),
  },
  {
    methods: new Set(["POST"]),
    path: new RegExp(`^${API_PREFIX}/videos/\\d+/(?:watch|bookmarks|ratings)$`),
  },
  {
    methods: new Set(["PATCH", "DELETE"]),
    path: new RegExp(`^${API_PREFIX}/(?:bookmarks|ratings)/\\d+$`),
  },
  {
    methods: new Set(["GET", "POST"]),
    path: new RegExp(`^${API_PREFIX}/favorites$`),
  },
  {
    methods: new Set(["DELETE"]),
    path: new RegExp(`^${API_PREFIX}/favorites/\\d+$`),
  },
  {
    methods: new Set(["GET"]),
    path: new RegExp(`^${API_PREFIX}/favorites/\\d+/check$`),
  },
  {
    methods: new Set(["GET", "POST"]),
    path: new RegExp(`^${API_PREFIX}/playlists$`),
  },
  {
    methods: new Set(["GET", "PATCH", "DELETE"]),
    path: new RegExp(`^${API_PREFIX}/playlists/\\d+$`),
  },
  {
    methods: new Set(["GET", "POST"]),
    path: new RegExp(`^${API_PREFIX}/playlists/\\d+/videos$`),
  },
  {
    methods: new Set(["POST"]),
    path: new RegExp(`^${API_PREFIX}/playlists/\\d+/videos/bulk$`),
  },
  {
    methods: new Set(["DELETE"]),
    path: new RegExp(`^${API_PREFIX}/playlists/\\d+/videos/\\d+$`),
  },
  {
    methods: new Set(["PATCH"]),
    path: new RegExp(`^${API_PREFIX}/playlists/\\d+/videos/reorder$`),
  },
  {
    methods: new Set(["GET", "POST"]),
    path: new RegExp(`^${API_PREFIX}/video-collections$`),
  },
  {
    methods: new Set(["GET", "PATCH", "DELETE"]),
    path: new RegExp(`^${API_PREFIX}/video-collections/\\d+$`),
  },
  {
    methods: new Set(["GET", "POST"]),
    path: new RegExp(`^${API_PREFIX}/video-collections/\\d+/entries$`),
  },
  {
    methods: new Set(["PATCH"]),
    path: new RegExp(`^${API_PREFIX}/video-collections/\\d+/entries/reorder$`),
  },
  {
    methods: new Set(["DELETE"]),
    path: new RegExp(`^${API_PREFIX}/video-collections/\\d+/entries/\\d+$`),
  },
  {
    methods: new Set(["GET", "POST"]),
    path: new RegExp(`^${API_PREFIX}/creators$`),
  },
  {
    methods: new Set(["GET"]),
    path: new RegExp(`^${API_PREFIX}/creators/(?:autocomplete|recent)$`),
  },
  {
    methods: new Set(["POST"]),
    path: new RegExp(`^${API_PREFIX}/creators/quick-create$`),
  },
  {
    methods: new Set(["GET", "PATCH", "DELETE"]),
    path: new RegExp(`^${API_PREFIX}/creators/\\d+$`),
  },
  {
    methods: new Set(["POST"]),
    path: new RegExp(`^${API_PREFIX}/creators/\\d+/merge$`),
  },
  {
    methods: new Set(["GET"]),
    path: new RegExp(
      `^${API_PREFIX}/creators/\\d+/(?:picture|videos|favorite/check|platforms|social-links|gallery|aliases)$`
    ),
  },
  // Face-reference reads are served from demo SQLite/assets. The separately
  // audited mutation patterns are listed in the promoted section below.
  {
    methods: new Set(["GET"]),
    path: new RegExp(
      `^${API_PREFIX}/creators/\\d+/face-embeddings(?:/\\d+/thumbnail)?$`
    ),
  },
  {
    methods: new Set(["GET"]),
    path: new RegExp(`^${API_PREFIX}/creators/\\d+/gallery/\\d+/image$`),
  },
  {
    methods: new Set(["POST", "DELETE"]),
    path: new RegExp(`^${API_PREFIX}/creators/\\d+/favorite$`),
  },
  {
    methods: new Set(["GET", "POST"]),
    path: new RegExp(`^${API_PREFIX}/studios$`),
  },
  {
    methods: new Set(["GET"]),
    path: new RegExp(`^${API_PREFIX}/studios/(?:autocomplete|recent)$`),
  },
  {
    methods: new Set(["POST"]),
    path: new RegExp(`^${API_PREFIX}/studios/quick-create$`),
  },
  {
    methods: new Set(["GET", "PATCH", "DELETE"]),
    path: new RegExp(`^${API_PREFIX}/studios/\\d+$`),
  },
  {
    methods: new Set(["GET"]),
    path: new RegExp(
      `^${API_PREFIX}/studios/\\d+/(?:picture|videos|social-links)$`
    ),
  },
  {
    methods: new Set(["GET", "POST"]),
    path: new RegExp(`^${API_PREFIX}/tags$`),
  },
  {
    methods: new Set(["GET"]),
    path: new RegExp(`^${API_PREFIX}/tags/categories$`),
  },
  {
    methods: new Set(["GET", "PATCH", "DELETE"]),
    path: new RegExp(`^${API_PREFIX}/tags/\\d+$`),
  },
  {
    methods: new Set(["GET"]),
    path: new RegExp(`^${API_PREFIX}/tags/\\d+/(?:children|videos)$`),
  },
  {
    methods: new Set(["GET"]),
    path: new RegExp(`^${API_PREFIX}/thumbnails/\\d+(?:/image)?$`),
  },
  {
    methods: new Set(["GET"]),
    path: new RegExp(`^${API_PREFIX}/artwork/\\d+/image$`),
  },
  // Enrichment review. Every handler short-circuits to demo SQLite before it
  // reaches the database or the external enrichment service, so the writing
  // methods here decide seeded proposals only and never leave the process.
  {
    methods: new Set(["GET"]),
    path: new RegExp(`^${API_PREFIX}/enrichment/suggestions$`),
  },
  {
    methods: new Set(["POST"]),
    path: new RegExp(
      `^${API_PREFIX}/enrichment/suggestions/\\d+/(?:accept|reject)$`
    ),
  },
  // All entity kinds run against the isolated SQLite catalog. A run only logs
  // a local scan and never reaches the enrichment network client.
  {
    methods: new Set(["GET"]),
    path: new RegExp(
      `^${API_PREFIX}/enrichment/(?:creator|scene|studio|tag)/\\d+/runs$`
    ),
  },
  {
    methods: new Set(["POST"]),
    path: new RegExp(
      `^${API_PREFIX}/enrichment/(?:creator|scene|studio|tag)/\\d+/run$`
    ),
  },
  {
    methods: new Set(["GET", "PATCH"]),
    path: new RegExp(`^${API_PREFIX}/settings$`),
  },
  {
    methods: new Set(["GET"]),
    path: new RegExp(
      `^${API_PREFIX}/stats/(?:storage|library|content|usage)(?:/history)?$`
    ),
  },
  {
    methods: new Set(["POST"]),
    path: new RegExp(
      `^${API_PREFIX}/stats/(?:snapshots|snapshot|(?:storage|library|content|usage)(?:-snapshots|/snapshot))$`
    ),
  },
  {
    methods: new Set(["GET"]),
    path: new RegExp(`^${API_PREFIX}/videos/\\d+/editing-metadata$`),
  },
  {
    methods: new Set(["POST"]),
    path: new RegExp(`^${API_PREFIX}/videos/\\d+/edits$`),
  },
  {
    methods: new Set(["GET"]),
    path: new RegExp(`^${API_PREFIX}/edits/jobs$`),
  },
  {
    methods: new Set(["GET"]),
    path: new RegExp(`^${API_PREFIX}/edits/jobs/\\d+$`),
  },
  {
    methods: new Set(["POST"]),
    path: new RegExp(`^${API_PREFIX}/edits/jobs/\\d+/cancel$`),
  },
  {
    methods: new Set(["POST"]),
    path: new RegExp(`^${API_PREFIX}/edits/jobs/\\d+/clone$`),
  },
  {
    methods: new Set(["GET"]),
    path: new RegExp(`^${API_PREFIX}/events/stream$`),
  },
  // The operations below were promoted only after their handlers were moved to
  // the isolated demo SQLite database/runtime asset directory and exercised by
  // request-level contracts. Keep the method/path pairs narrow: an unreviewed
  // sibling action must continue to fall through to the deny-by-default return.
  {
    methods: new Set(["GET", "POST"]),
    path: new RegExp(`^${API_PREFIX}/directories$`),
  },
  {
    methods: new Set(["GET", "PATCH", "DELETE"]),
    path: new RegExp(`^${API_PREFIX}/directories/\\d+$`),
  },
  {
    methods: new Set(["POST"]),
    path: new RegExp(`^${API_PREFIX}/directories/\\d+/scan$`),
  },
  {
    methods: new Set(["GET"]),
    path: new RegExp(`^${API_PREFIX}/directories/\\d+/scans$`),
  },
  {
    methods: new Set(["GET"]),
    path: new RegExp(`^${API_PREFIX}/directories/\\d+/scans/\\d+$`),
  },
  {
    methods: new Set(["GET"]),
    path: new RegExp(`^${API_PREFIX}/directories/scheduler/status$`),
  },
  {
    methods: new Set(["GET"]),
    path: new RegExp(`^${API_PREFIX}/directories/\\d+/stats$`),
  },
  {
    methods: new Set(["POST"]),
    path: new RegExp(
      `^${API_PREFIX}/videos/(?:bulk/(?:delete|creators|tags|studios|favorites|conditional-apply)|unavailable/(?:verify|cleanup))$`
    ),
  },
  {
    methods: new Set(["GET"]),
    path: new RegExp(`^${API_PREFIX}/videos/duplicates$`),
  },
  {
    methods: new Set(["POST"]),
    path: new RegExp(
      `^${API_PREFIX}/videos/\\d+/(?:verify|refresh|creators|tags|metadata)$`
    ),
  },
  {
    methods: new Set(["GET"]),
    path: new RegExp(`^${API_PREFIX}/videos/\\d+/metadata$`),
  },
  {
    methods: new Set(["POST"]),
    path: new RegExp(`^${API_PREFIX}/videos/\\d+/studios/\\d+$`),
  },
  {
    methods: new Set(["DELETE"]),
    path: new RegExp(
      `^${API_PREFIX}/videos/\\d+/(?:creators/\\d+|tags/\\d+|metadata/[^/]+|studios/\\d+)$`
    ),
  },
  {
    methods: new Set(["POST"]),
    path: new RegExp(`^${API_PREFIX}/creators/bulk$`),
  },
  {
    methods: new Set(["POST", "DELETE"]),
    path: new RegExp(`^${API_PREFIX}/creators/\\d+/picture$`),
  },
  {
    methods: new Set(["POST"]),
    path: new RegExp(`^${API_PREFIX}/creators/\\d+/picture-from-url$`),
  },
  {
    methods: new Set(["POST"]),
    path: new RegExp(
      `^${API_PREFIX}/creators/\\d+/(?:platforms|platforms/bulk|social-links|social-links/bulk|gallery|gallery-from-url|aliases|aliases/bulk)$`
    ),
  },
  {
    methods: new Set(["PATCH", "DELETE"]),
    path: new RegExp(
      `^${API_PREFIX}/creators/\\d+/(?:platforms|social-links|gallery|aliases)/\\d+$`
    ),
  },
  {
    methods: new Set(["GET"]),
    path: new RegExp(`^${API_PREFIX}/creators/\\d+/studios$`),
  },
  {
    methods: new Set(["POST", "DELETE"]),
    path: new RegExp(`^${API_PREFIX}/creators/\\d+/studios/\\d+$`),
  },
  {
    methods: new Set(["POST"]),
    path: new RegExp(`^${API_PREFIX}/studios/bulk$`),
  },
  {
    methods: new Set(["POST", "DELETE"]),
    path: new RegExp(`^${API_PREFIX}/studios/\\d+/picture$`),
  },
  {
    methods: new Set(["POST"]),
    path: new RegExp(`^${API_PREFIX}/studios/\\d+/picture-from-url$`),
  },
  {
    methods: new Set(["POST"]),
    path: new RegExp(
      `^${API_PREFIX}/studios/\\d+/(?:social-links|social-links/bulk|creators/bulk)$`
    ),
  },
  {
    methods: new Set(["PATCH", "DELETE"]),
    path: new RegExp(`^${API_PREFIX}/studios/\\d+/social-links/\\d+$`),
  },
  {
    methods: new Set(["GET"]),
    path: new RegExp(`^${API_PREFIX}/studios/\\d+/creators$`),
  },
  {
    methods: new Set(["POST", "DELETE"]),
    path: new RegExp(`^${API_PREFIX}/studios/\\d+/(?:creators|videos)/\\d+$`),
  },
  {
    methods: new Set(["POST"]),
    path: new RegExp(`^${API_PREFIX}/videos/\\d+/thumbnails$`),
  },
  {
    methods: new Set(["DELETE"]),
    path: new RegExp(`^${API_PREFIX}/thumbnails/\\d+$`),
  },
  {
    methods: new Set(["POST", "DELETE"]),
    path: new RegExp(`^${API_PREFIX}/videos/\\d+/(?:artwork|storyboard)$`),
  },
  {
    methods: new Set(["POST"]),
    path: new RegExp(`^${API_PREFIX}/artwork/batch$`),
  },
  {
    methods: new Set(["GET", "POST"]),
    path: new RegExp(`^${API_PREFIX}/backup$`),
  },
  {
    methods: new Set(["GET"]),
    path: new RegExp(`^${API_PREFIX}/backup/export$`),
  },
  {
    methods: new Set(["POST"]),
    path: new RegExp(`^${API_PREFIX}/backup/[^/]+/restore$`),
  },
  {
    methods: new Set(["DELETE"]),
    path: new RegExp(`^${API_PREFIX}/backup/(?!export$)[^/]+$`),
  },
  {
    methods: new Set(["GET"]),
    path: new RegExp(
      `^${API_PREFIX}/(?:triage/(?:progress|stats)|users/(?:triage-progress|triage/statistics))$`
    ),
  },
  {
    methods: new Set(["POST"]),
    path: new RegExp(
      `^${API_PREFIX}/(?:triage/(?:progress|bulk-actions)|users/(?:triage-progress|triage/bulk-actions))$`
    ),
  },
  {
    methods: new Set(["GET", "POST"]),
    path: new RegExp(`^${API_PREFIX}/tagging-rules$`),
  },
  {
    methods: new Set(["GET", "PATCH", "DELETE"]),
    path: new RegExp(`^${API_PREFIX}/tagging-rules/\\d+$`),
  },
  {
    methods: new Set(["POST"]),
    path: new RegExp(
      `^${API_PREFIX}/tagging-rules/(?:bulk/delete|apply|\\d+/test)$`
    ),
  },
  {
    methods: new Set(["GET"]),
    path: new RegExp(`^${API_PREFIX}/faces/health$`),
  },
  {
    methods: new Set(["POST"]),
    path: new RegExp(
      `^${API_PREFIX}/creators/\\d+/face-embeddings(?:/base64|/from-gallery/\\d+)?$`
    ),
  },
  {
    methods: new Set(["PUT"]),
    path: new RegExp(
      `^${API_PREFIX}/creators/\\d+/face-embeddings/\\d+/primary$`
    ),
  },
  {
    methods: new Set(["DELETE"]),
    path: new RegExp(`^${API_PREFIX}/creators/\\d+/face-embeddings/\\d+$`),
  },
  {
    methods: new Set(["GET"]),
    path: new RegExp(`^${API_PREFIX}/videos/\\d+/faces(?:/status)?$`),
  },
  {
    methods: new Set(["GET"]),
    path: new RegExp(`^${API_PREFIX}/faces/\\d+/image$`),
  },
  {
    methods: new Set(["POST"]),
    path: new RegExp(`^${API_PREFIX}/videos/\\d+/faces/extract$`),
  },
  {
    methods: new Set(["PUT"]),
    path: new RegExp(
      `^${API_PREFIX}/videos/\\d+/faces/\\d+/(?:confirm|reject)$`
    ),
  },
  {
    methods: new Set(["GET"]),
    path: new RegExp(`^${API_PREFIX}/creators/\\d+/videos-by-face$`),
  },
  {
    methods: new Set(["POST"]),
    path: new RegExp(`^${API_PREFIX}/faces/search$`),
  },
  {
    methods: new Set(["DELETE"]),
    path: new RegExp(`^${API_PREFIX}/faces/queue$`),
  },
  {
    methods: new Set(["POST"]),
    path: new RegExp(
      `^${API_PREFIX}/multiplayer-remote/(?:display-devices|sessions|pair|trusted-devices/discover)$`
    ),
  },
  {
    methods: new Set(["GET"]),
    path: new RegExp(
      `^${API_PREFIX}/multiplayer-remote/(?:ws|sessions/\\d+(?:/join-requests/pending)?)$`
    ),
  },
  {
    methods: new Set(["POST"]),
    path: new RegExp(
      `^${API_PREFIX}/multiplayer-remote/sessions/\\d+/(?:close|trusted-connect|join-requests/\\d+/(?:approve|reject))$`
    ),
  },
];

function normalizePath(url: string): string {
  const queryIndex = url.indexOf("?");
  const path = queryIndex >= 0 ? url.slice(0, queryIndex) : url;
  if (path.length > 1 && path.endsWith("/")) {
    return path.slice(0, -1);
  }
  return path;
}

/**
 * Demo mode is fail-closed: only routes whose handlers are backed by demo
 * SQLite/assets are reachable. A newly added route is blocked until it is
 * explicitly audited and added here.
 */
export function isDemoRequestAllowed(method: string, url: string): boolean {
  const requestedMethod = method.toUpperCase();
  // Fastify automatically registers HEAD siblings for GET routes. Treating
  // HEAD as an unrelated method caused the demo guard to send a 403 before the
  // generated HEAD handler ran, which could also produce a second-reply error.
  // Keeping the normalization here guarantees that HEAD has exactly the same
  // privacy classification as its GET counterpart.
  const normalizedMethod = requestedMethod === "HEAD" ? "GET" : requestedMethod;
  const path = normalizePath(url);

  if (normalizedMethod === "OPTIONS") {
    return true;
  }

  if (
    normalizedMethod === "GET" &&
    READ_ONLY_PUBLIC_PATHS.some((pattern) => pattern.test(path))
  ) {
    return true;
  }

  return SAFE_API_REQUESTS.some(
    (request) =>
      request.methods.has(normalizedMethod) && request.path.test(path)
  );
}
