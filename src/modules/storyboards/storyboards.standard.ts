/**
 * The storyboard standard: what a storyboard generated today looks like for a given video.
 * Tiles keep the video's own shape, so neither black bars nor stretching reach the
 * SigLIP2 visual-search model, which squashes each tile to 256×256. A short side of 256
 * gives the model all the pixels it can use; benchmarks (2026-10-03) put 320×180 and the
 * old letterboxed 320×240 clearly below it.
 */

/** Widest (or tallest) tile relative to its short side; beyond this the tile is letterboxed. */
const MAX_ASPECT = 2;

const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);

export function standardTileSize(
  width: number | null | undefined,
  height: number | null | undefined,
  shortSide: number
): { tileWidth: number; tileHeight: number } {
  const short = even(shortSide);
  if (!width || !height || width <= 0 || height <= 0)
    return { tileWidth: even((short * 16) / 9), tileHeight: short };
  const long = even(Math.min(MAX_ASPECT, Math.max(width, height) / Math.min(width, height)) * short);
  return width >= height
    ? { tileWidth: long, tileHeight: short }
    : { tileWidth: short, tileHeight: long };
}

/** The requested interval, widened only when the video would exceed the tile cap. */
export function standardIntervalSeconds(
  durationSeconds: number,
  requestedSeconds: number,
  maxTiles: number
): number {
  return Math.max(1, requestedSeconds, Math.ceil(durationSeconds / Math.max(1, maxTiles)));
}

/**
 * Whether an existing storyboard was generated to the current standard. Encoder quality and
 * sampling are not recorded, so tile size and interval stand in for them.
 */
export function matchesStandard(
  storyboard: { tileWidth: number; tileHeight: number; intervalSeconds: number },
  standard: { tileWidth: number; tileHeight: number; intervalSeconds: number }
): boolean {
  return (
    storyboard.tileWidth === standard.tileWidth &&
    storyboard.tileHeight === standard.tileHeight &&
    storyboard.intervalSeconds === standard.intervalSeconds
  );
}
