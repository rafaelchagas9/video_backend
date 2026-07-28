import { API_PREFIX } from "@/config/constants";

const READ_ONLY_PUBLIC_PATHS = [/^\/health$/, /^\/docs(?:\/.*)?$/];

const SAFE_API_REQUESTS: Array<{
  methods: ReadonlySet<string>;
  path: RegExp;
}> = [
  {
    methods: new Set(["GET", "POST"]),
    path: new RegExp(`^${API_PREFIX}/auth/(?:login|logout|me|register)$`),
  },
  {
    methods: new Set(["GET"]),
    path: new RegExp(
      `^${API_PREFIX}/videos(?:/(?:compression-suggestions|next|triage-queue|unavailable|random|history))?$`,
    ),
  },
  {
    methods: new Set(["GET", "PATCH", "DELETE"]),
    path: new RegExp(`^${API_PREFIX}/videos/\\d+$`),
  },
  {
    methods: new Set(["GET"]),
    path: new RegExp(
      `^${API_PREFIX}/videos/\\d+/(?:related|stream|creators|tags|studios|ratings|bookmarks|stats|thumbnails|storyboard)$`,
    ),
  },
  {
    methods: new Set(["GET"]),
    path: new RegExp(
      `^${API_PREFIX}/videos/\\d+/(?:thumbnails\\.vtt|storyboard\\.(?:jpg|webp))$`,
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
    methods: new Set(["GET", "POST", "DELETE"]),
    path: new RegExp(`^${API_PREFIX}/favorites(?:/\\d+(?:/check)?)?$`),
  },
  {
    methods: new Set(["GET", "POST", "PATCH", "DELETE"]),
    path: new RegExp(
      `^${API_PREFIX}/playlists(?:/\\d+(?:/videos(?:/\\d+|/bulk|/reorder)?)?)?$`,
    ),
  },
  {
    methods: new Set(["GET", "POST", "PATCH", "DELETE"]),
    path: new RegExp(
      `^${API_PREFIX}/video-collections(?:/\\d+(?:/entries(?:/\\d+|/reorder)?)?)?$`,
    ),
  },
  {
    methods: new Set(["GET", "POST"]),
    path: new RegExp(
      `^${API_PREFIX}/creators(?:/(?:autocomplete|recent|quick-create))?$`,
    ),
  },
  {
    methods: new Set(["GET", "PATCH", "DELETE"]),
    path: new RegExp(`^${API_PREFIX}/creators/\\d+$`),
  },
  {
    methods: new Set(["GET"]),
    path: new RegExp(
      `^${API_PREFIX}/creators/\\d+/(?:picture|videos|favorite/check|platforms|social-links|gallery)$`,
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
    path: new RegExp(
      `^${API_PREFIX}/studios(?:/(?:autocomplete|recent|quick-create))?$`,
    ),
  },
  {
    methods: new Set(["GET", "PATCH", "DELETE"]),
    path: new RegExp(`^${API_PREFIX}/studios/\\d+$`),
  },
  {
    methods: new Set(["GET"]),
    path: new RegExp(
      `^${API_PREFIX}/studios/\\d+/(?:picture|videos|social-links)$`,
    ),
  },
  {
    methods: new Set(["GET", "POST"]),
    path: new RegExp(`^${API_PREFIX}/tags$`),
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
    methods: new Set(["GET", "PATCH"]),
    path: new RegExp(`^${API_PREFIX}/settings$`),
  },
  {
    methods: new Set(["GET"]),
    path: new RegExp(`^${API_PREFIX}/events/stream$`),
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
 * memory/assets are reachable. A newly added route is blocked until it is
 * explicitly audited and added here.
 */
export function isDemoRequestAllowed(method: string, url: string): boolean {
  const normalizedMethod = method.toUpperCase();
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
      request.methods.has(normalizedMethod) && request.path.test(path),
  );
}
