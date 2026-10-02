/**
 * Storyboard page layout.
 *
 * A storyboard is split into small pages of at most PAGE_COLUMNS×PAGE_ROWS
 * tiles instead of one sheet. A long video's single sheet grew to ~100 MP,
 * which clients could only show downscaled (blurry) or by region-decoding it,
 * and lossy WebP has no random access, so region decoding a tile re-decodes
 * everything above it. Pages are small enough to decode whole.
 *
 * Page files sit next to each other as `<base>.p<N>.<ext>`; `sprite_path`
 * points at page 0, so it stays a regular readable file. The last page is
 * trimmed to the tiles it holds, so every page's pixel size equals the extent
 * of its cues in the VTT and clients never need the image's natural size.
 */

import { basename } from "path";

export const PAGE_COLUMNS = 5;
export const PAGE_ROWS = 5;
export const TILES_PER_PAGE = PAGE_COLUMNS * PAGE_ROWS;

const PAGE_FILE = /^(.*)\.p(\d+)\.(webp|jpg)$/;

export type StoryboardFormat = "webp" | "jpg";

export function storyboardPageCount(tileCount: number): number {
  return Math.max(1, Math.ceil(tileCount / TILES_PER_PAGE));
}

/** Where tile `index` lands: its page and pixel offset within that page. */
export function storyboardTilePlacement(
  index: number,
  tileWidth: number,
  tileHeight: number
): { page: number; x: number; y: number } {
  const slot = index % TILES_PER_PAGE;
  return {
    page: Math.floor(index / TILES_PER_PAGE),
    x: (slot % PAGE_COLUMNS) * tileWidth,
    y: Math.floor(slot / PAGE_COLUMNS) * tileHeight,
  };
}

/** Pixel size of `page`; only the last page can be smaller than a full grid. */
export function storyboardPageSize(
  page: number,
  tileCount: number,
  tileWidth: number,
  tileHeight: number
): { width: number; height: number } {
  const tiles = Math.min(
    TILES_PER_PAGE,
    Math.max(0, tileCount - page * TILES_PER_PAGE)
  );
  return {
    width: Math.min(PAGE_COLUMNS, tiles) * tileWidth,
    height: Math.ceil(tiles / PAGE_COLUMNS) * tileHeight,
  };
}

export function storyboardPagePaths(
  base: string,
  format: StoryboardFormat,
  tileCount: number
): string[] {
  return Array.from(
    { length: storyboardPageCount(tileCount) },
    (_, page) => `${base}.p${page}.${format}`
  );
}

/** True for page 0 of a paged storyboard; false for a legacy single sheet. */
export function isPagedSpritePath(spritePath: string): boolean {
  return PAGE_FILE.exec(spritePath)?.[2] === "0";
}

/** Every image file of a storyboard, given its `sprite_path` and tile count. */
export function storyboardImagePaths(
  spritePath: string,
  tileCount: number
): string[] {
  const match = PAGE_FILE.exec(spritePath);
  if (!match || match[2] !== "0") return [spritePath];
  return storyboardPagePaths(
    match[1]!,
    match[3] as StoryboardFormat,
    tileCount
  );
}

/** Image and VTT files of a storyboard row, for cleanup. */
export function storyboardAssetPaths(row: {
  spritePath: string;
  vttPath: string;
  tileCount: number;
}): string[] {
  return [...storyboardImagePaths(row.spritePath, row.tileCount), row.vttPath];
}

export function formatVttTime(seconds: number): string {
  const totalMillis = Math.round(seconds * 1000);
  const hours = Math.floor(totalMillis / 3_600_000);
  const minutes = Math.floor((totalMillis % 3_600_000) / 60_000);
  const secs = Math.floor((totalMillis % 60_000) / 1000);
  const millis = totalMillis % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

/**
 * WebVTT whose cues point at their page. `?v=` carries the VTT file name so a
 * regenerated storyboard never reuses a cached page from the previous one.
 */
export function buildPagedStoryboardVtt(input: {
  videoId: number;
  vttPath: string;
  format: StoryboardFormat;
  tileWidth: number;
  tileHeight: number;
  cues: ReadonlyArray<{ start: number; end: number }>;
}): string {
  const version = encodeURIComponent(basename(input.vttPath));
  let vtt = "WEBVTT\n\n";
  input.cues.forEach((cue, index) => {
    const { page, x, y } = storyboardTilePlacement(
      index,
      input.tileWidth,
      input.tileHeight
    );
    vtt += `${formatVttTime(cue.start)} --> ${formatVttTime(cue.end)}\n`;
    vtt += `/api/videos/${input.videoId}/storyboard/pages/${page}.${input.format}?v=${version}#xywh=${x},${y},${input.tileWidth},${input.tileHeight}\n\n`;
  });
  return vtt;
}
