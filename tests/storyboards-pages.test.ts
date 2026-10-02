import { expect, it } from "bun:test";
import {
  buildPagedStoryboardVtt,
  isPagedSpritePath,
  storyboardAssetPaths,
  storyboardImagePaths,
  storyboardPageCount,
  storyboardPageSize,
  storyboardTilePlacement,
} from "@/modules/storyboards/storyboards.pages";

function cuesOf(vtt: string) {
  return vtt
    .trim()
    .split("\n\n")
    .slice(1)
    .map((block) => {
      const [timing, target] = block.split("\n");
      const [url, xywh] = target!.split("#xywh=");
      return { start: timing!.split(" --> ")[0], url, xywh };
    });
}

it("places tiles row-major within 5×5 pages", () => {
  expect(storyboardTilePlacement(0, 320, 240)).toEqual({ page: 0, x: 0, y: 0 });
  expect(storyboardTilePlacement(7, 320, 240)).toEqual({ page: 0, x: 640, y: 240 });
  expect(storyboardTilePlacement(24, 320, 240)).toEqual({ page: 0, x: 1280, y: 960 });
  expect(storyboardTilePlacement(25, 320, 240)).toEqual({ page: 1, x: 0, y: 0 });
});

it("sizes pages to the tiles they hold", () => {
  expect(storyboardPageCount(1)).toBe(1);
  expect(storyboardPageCount(25)).toBe(1);
  expect(storyboardPageCount(26)).toBe(2);
  expect(storyboardPageSize(0, 27, 320, 240)).toEqual({ width: 1600, height: 1200 });
  expect(storyboardPageSize(1, 27, 320, 240)).toEqual({ width: 640, height: 240 });
  expect(storyboardPageSize(0, 12, 320, 240)).toEqual({ width: 1600, height: 720 });
});

it("derives every page file from page 0, and leaves legacy sheets alone", () => {
  expect(isPagedSpritePath("/s/storyboard_1_2.p0.webp")).toBe(true);
  expect(isPagedSpritePath("/s/storyboard_1_2.webp")).toBe(false);
  expect(storyboardImagePaths("/s/storyboard_1_2.p0.webp", 51)).toEqual([
    "/s/storyboard_1_2.p0.webp",
    "/s/storyboard_1_2.p1.webp",
    "/s/storyboard_1_2.p2.webp",
  ]);
  expect(storyboardImagePaths("/s/storyboard_1_2.webp", 51)).toEqual([
    "/s/storyboard_1_2.webp",
  ]);
  expect(
    storyboardAssetPaths({
      spritePath: "/s/b.p0.jpg",
      vttPath: "/s/b.vtt",
      tileCount: 26,
    })
  ).toEqual(["/s/b.p0.jpg", "/s/b.p1.jpg", "/s/b.vtt"]);
});

it("writes cues that point at their page with in-page offsets", () => {
  const vtt = buildPagedStoryboardVtt({
    videoId: 9,
    vttPath: "/s/storyboard_9_1.vtt",
    format: "webp",
    tileWidth: 320,
    tileHeight: 240,
    cues: Array.from({ length: 27 }, (_, index) => ({
      start: index * 5,
      end: index * 5 + 5,
    })),
  });
  const cues = cuesOf(vtt);
  expect(cues).toHaveLength(27);
  expect(cues[26]).toEqual({
    start: "00:02:10.000",
    url: "/api/videos/9/storyboard/pages/1.webp?v=storyboard_9_1.vtt",
    xywh: "320,0,320,240",
  });
});
