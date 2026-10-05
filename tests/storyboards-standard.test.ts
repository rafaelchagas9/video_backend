import { describe, expect, it } from "bun:test";
import {
  matchesStandard,
  standardIntervalSeconds,
  standardTileSize,
} from "@/modules/storyboards/storyboards.standard";

describe("standardTileSize", () => {
  it("keeps the video's shape with a fixed short side", () => {
    expect(standardTileSize(1920, 1080, 256)).toEqual({ tileWidth: 456, tileHeight: 256 });
    expect(standardTileSize(1080, 1920, 256)).toEqual({ tileWidth: 256, tileHeight: 456 });
    expect(standardTileSize(1440, 1080, 256)).toEqual({ tileWidth: 342, tileHeight: 256 });
    expect(standardTileSize(720, 720, 256)).toEqual({ tileWidth: 256, tileHeight: 256 });
  });

  it("caps extreme aspect ratios at 2:1", () => {
    expect(standardTileSize(5760, 1080, 256)).toEqual({ tileWidth: 512, tileHeight: 256 });
    expect(standardTileSize(1170, 2532, 256)).toEqual({ tileWidth: 256, tileHeight: 512 });
  });

  it("falls back to 16:9 when dimensions are unknown", () => {
    expect(standardTileSize(null, 1080, 256)).toEqual({ tileWidth: 456, tileHeight: 256 });
  });
});

describe("standardIntervalSeconds", () => {
  it("keeps the requested interval until the tile cap forces it wider", () => {
    expect(standardIntervalSeconds(3600, 5, 4320)).toBe(5);
    expect(standardIntervalSeconds(30_000, 5, 4320)).toBe(7);
  });
});

it("matchesStandard compares tile size and interval", () => {
  const standard = { tileWidth: 456, tileHeight: 256, intervalSeconds: 5 };
  expect(matchesStandard(standard, standard)).toBe(true);
  expect(matchesStandard({ ...standard, tileWidth: 320, tileHeight: 240 }, standard)).toBe(false);
  expect(matchesStandard({ ...standard, intervalSeconds: 8 }, standard)).toBe(false);
});
