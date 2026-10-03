/** Pure replay-heat arithmetic: accumulate watched passes, smooth, and find the peaks. */

export const HEAT_BUCKET_SECONDS = 5;
/** Below this much recorded watching a curve is one stray play, not a pattern. */
export const HEAT_MIN_WATCHED_SECONDS = 45;
/** Points sent to clients; enough for a smooth curve over any player width. */
export const HEAT_POINTS = 160;

export interface HeatPeak {
  start_seconds: number;
  end_seconds: number;
  peak_seconds: number;
  /** 0–1, relative to the hottest stretch of this video. */
  intensity: number;
}

/** Add one pass over [from, to] seconds; partial buckets count by their covered fraction. */
export function addPass(
  buckets: number[],
  from: number,
  to: number,
  bucketSeconds = HEAT_BUCKET_SECONDS
): number[] {
  const out = buckets.slice();
  if (!(to > from) || from < 0) return out;
  const first = Math.floor(from / bucketSeconds);
  const last = Math.floor((to - 1e-9) / bucketSeconds);
  while (out.length <= last) out.push(0);
  for (let index = first; index <= last; index++) {
    const start = index * bucketSeconds;
    const covered = Math.min(to, start + bucketSeconds) - Math.max(from, start);
    out[index] = (out[index] ?? 0) + covered / bucketSeconds;
  }
  return out;
}

/** Gaussian smoothing so single-bucket spikes read as stretches. */
export function smooth(values: number[], radius = 2): number[] {
  if (!values.length) return [];
  const sigma = Math.max(0.5, radius / 1.5);
  const kernel = Array.from({ length: radius * 2 + 1 }, (_, i) =>
    Math.exp(-((i - radius) ** 2) / (2 * sigma * sigma))
  );
  return values.map((_, index) => {
    let sum = 0;
    let weight = 0;
    kernel.forEach((k, offset) => {
      const value = values[index + offset - radius];
      if (value === undefined) return;
      sum += value * k;
      weight += k;
    });
    return weight ? sum / weight : 0;
  });
}

/** Resample to `points` values over the whole duration, normalised to the maximum. */
export function curve(
  buckets: number[],
  durationSeconds: number,
  bucketSeconds = HEAT_BUCKET_SECONDS,
  points = HEAT_POINTS
): number[] {
  const total = Math.max(1, Math.ceil(durationSeconds / bucketSeconds));
  const padded = Array.from({ length: total }, (_, index) => buckets[index] ?? 0);
  const smoothed = smooth(padded);
  const max = Math.max(...smoothed, 0);
  if (max <= 0) return Array.from({ length: Math.min(points, total) }, () => 0);
  const count = Math.min(points, total);
  return Array.from({ length: count }, (_, point) => {
    const from = Math.floor((point * total) / count);
    const to = Math.max(from + 1, Math.floor(((point + 1) * total) / count));
    let best = 0;
    for (let index = from; index < to; index++) best = Math.max(best, smoothed[index] ?? 0);
    return Math.round((best / max) * 1000) / 1000;
  });
}

/**
 * Stretches clearly above the video's typical heat. A video watched evenly has no peaks; one
 * whose viewer keeps returning to a scene has that scene as a peak.
 */
export function peaks(
  buckets: number[],
  durationSeconds: number,
  bucketSeconds = HEAT_BUCKET_SECONDS,
  limit = 5
): HeatPeak[] {
  const total = Math.max(1, Math.ceil(durationSeconds / bucketSeconds));
  const smoothed = smooth(Array.from({ length: total }, (_, index) => buckets[index] ?? 0));
  const max = Math.max(...smoothed, 0);
  if (max <= 0) return [];
  const watched = smoothed.filter((value) => value > 0);
  const mean = watched.reduce((sum, value) => sum + value, 0) / Math.max(1, watched.length);
  const threshold = Math.max(max * 0.55, mean * 1.35);
  const found: HeatPeak[] = [];
  let index = 0;
  while (index < total) {
    if ((smoothed[index] ?? 0) < threshold) {
      index++;
      continue;
    }
    const start = index;
    let best = index;
    while (index < total && (smoothed[index] ?? 0) >= threshold) {
      if ((smoothed[index] ?? 0) > (smoothed[best] ?? 0)) best = index;
      index++;
    }
    found.push({
      start_seconds: start * bucketSeconds,
      end_seconds: Math.min(durationSeconds, index * bucketSeconds),
      peak_seconds: best * bucketSeconds + bucketSeconds / 2,
      intensity: Math.round(((smoothed[best] ?? 0) / max) * 1000) / 1000,
    });
  }
  // A curve that is above threshold almost everywhere has no distinct highlight.
  const covered = found.reduce((sum, peak) => sum + peak.end_seconds - peak.start_seconds, 0);
  if (covered > durationSeconds * 0.6) return [];
  return found.sort((a, b) => b.intensity - a.intensity).slice(0, limit);
}
