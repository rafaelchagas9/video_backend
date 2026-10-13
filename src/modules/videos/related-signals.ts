/** Related-video signals that need no metadata: how alike two videos look, and a shared small folder. */

export interface VideoNeighbour {
  videoId: number;
  /** Mean best-frame similarity over the probes; a neighbour missing from a probe's pool counts 0 there. */
  score: number;
}

/** Neighbours further than this (cosine) below the best match are not "similar", just nearest. */
const VISUAL_BAND = 0.12;
const VISUAL_MIN_SCORE = 0.3;
const VISUAL_DUPLICATE_SCORE = 0.985;
const VISUAL_MIN_POINTS = 16;
const VISUAL_MAX_POINTS = 48;
/** A folder this small was put together on purpose; a dump folder says nothing about its files. */
const SMALL_FOLDER_MAX = 50;
export const SAME_FOLDER_POINTS = 16;

/** Points scale with closeness inside the band under the best neighbour. Copies of the same
 * file are left out: they are duplicates to clean up, not something to watch next. */
export function visualPoints(neighbours: VideoNeighbour[]): Map<number, number> {
  const distinct = neighbours.filter((neighbour) => neighbour.score < VISUAL_DUPLICATE_SCORE);
  const top = distinct[0]?.score ?? 0;
  const points = new Map<number, number>();
  if (top < VISUAL_MIN_SCORE) return points;
  const floor = top - VISUAL_BAND;
  for (const { videoId, score } of distinct) {
    if (score < floor) continue;
    const closeness = (score - floor) / VISUAL_BAND;
    points.set(videoId, Math.round(VISUAL_MIN_POINTS + closeness * (VISUAL_MAX_POINTS - VISUAL_MIN_POINTS)));
  }
  return points;
}

export function folderOf(filePath: string | null | undefined): string {
  if (!filePath) return "";
  const index = filePath.replace(/\\/g, "/").lastIndexOf("/");
  return index > 0 ? filePath.slice(0, index) : "";
}

export function folderSizesOf(videos: { file_path?: string | null }[]): Map<string, number> {
  const sizes = new Map<string, number>();
  for (const video of videos) {
    const folder = folderOf(video.file_path);
    if (folder) sizes.set(folder, (sizes.get(folder) ?? 0) + 1);
  }
  return sizes;
}

export function isSmallFolder(source: string, candidate: string, sizes: Map<string, number>): boolean {
  return Boolean(source) && source === candidate && (sizes.get(source) ?? 0) <= SMALL_FOLDER_MAX;
}
