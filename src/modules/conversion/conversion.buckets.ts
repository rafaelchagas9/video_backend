/**
 * Shared bucket definitions for conversion insights.
 *
 * Buckets are declared once so the insights aggregation, the history filters
 * and the API documentation all describe the same bands.
 */

export interface ResolutionBucket {
  key: string;
  label: string;
  /** Inclusive lower bound on the long edge, in pixels. */
  minLongEdge: number;
  /** Exclusive upper bound on the long edge, or null for open-ended. */
  maxLongEdge: number | null;
}

/** Ordered high → low so the first match wins when classifying. */
export const RESOLUTION_BUCKETS: readonly ResolutionBucket[] = [
  { key: "4k", label: "4K+", minLongEdge: 3200, maxLongEdge: null },
  { key: "1440p", label: "1440p", minLongEdge: 2400, maxLongEdge: 3200 },
  { key: "1080p", label: "1080p", minLongEdge: 1800, maxLongEdge: 2400 },
  { key: "720p", label: "720p", minLongEdge: 1200, maxLongEdge: 1800 },
  { key: "sd", label: "SD", minLongEdge: 0, maxLongEdge: 1200 },
];

export interface BitrateBucket {
  key: string;
  label: string;
  /** Inclusive lower bound in Mbps. */
  minMbps: number;
  /** Exclusive upper bound in Mbps, or null for open-ended. */
  maxMbps: number | null;
}

export const BITRATE_BUCKETS: readonly BitrateBucket[] = [
  { key: "lt2", label: "< 2 Mbps", minMbps: 0, maxMbps: 2 },
  { key: "2-4", label: "2–4 Mbps", minMbps: 2, maxMbps: 4 },
  { key: "4-6", label: "4–6 Mbps", minMbps: 4, maxMbps: 6 },
  { key: "6-8", label: "6–8 Mbps", minMbps: 6, maxMbps: 8 },
  { key: "8-12", label: "8–12 Mbps", minMbps: 8, maxMbps: 12 },
  { key: "12-20", label: "12–20 Mbps", minMbps: 12, maxMbps: 20 },
  { key: "20-35", label: "20–35 Mbps", minMbps: 20, maxMbps: 35 },
  { key: "gte35", label: "35+ Mbps", minMbps: 35, maxMbps: null },
];

export interface FpsBucket {
  key: string;
  label: string;
  maxFps: number | null;
}

export const FPS_BUCKETS: readonly FpsBucket[] = [
  { key: "25", label: "≤ 25 fps", maxFps: 26 },
  { key: "30", label: "30 fps", maxFps: 32 },
  { key: "48", label: "48 fps", maxFps: 50 },
  { key: "60", label: "60 fps", maxFps: 62 },
  { key: "high", label: "> 60 fps", maxFps: null },
];

export const UNKNOWN_BUCKET_KEY = "unknown";
export const UNKNOWN_BUCKET_LABEL = "Unknown";

export function classifyResolution(
  width: number | null,
  height: number | null,
): ResolutionBucket | null {
  if (!width && !height) return null;

  const longEdge = Math.max(width ?? 0, height ?? 0);
  if (longEdge <= 0) return null;

  return (
    RESOLUTION_BUCKETS.find(
      (bucket) =>
        longEdge >= bucket.minLongEdge &&
        (bucket.maxLongEdge === null || longEdge < bucket.maxLongEdge),
    ) ?? null
  );
}

export function classifyBitrate(bitrate: number | null): BitrateBucket | null {
  if (!bitrate || bitrate <= 0) return null;

  const mbps = bitrate / 1_000_000;

  return (
    BITRATE_BUCKETS.find(
      (bucket) =>
        mbps >= bucket.minMbps &&
        (bucket.maxMbps === null || mbps < bucket.maxMbps),
    ) ?? null
  );
}

export function classifyFps(fps: number | null): FpsBucket | null {
  if (!fps || fps <= 0) return null;

  return (
    FPS_BUCKETS.find((bucket) => bucket.maxFps === null || fps < bucket.maxFps) ??
    null
  );
}
