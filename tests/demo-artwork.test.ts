import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "fs";
import { demoArtworkService } from "@/modules/artwork/artwork.demo.service";
import { videoArtworkSchema } from "@/modules/artwork/artwork.schemas";
import { demoRepository } from "@/database/demo/repository";
import { isDemoAssetPath } from "@/database/demo/assets";
import { useSeededDemoDatabase } from "./helpers/demo-database";
import { getDemoSqlite } from "@/database/demo";

useSeededDemoDatabase({ artwork: true });

beforeEach(() => {
  // Analysis demo scenarios rename source videos. This fixture exercises the
  // matching-title case explicitly, independently of those display labels.
  getDemoSqlite().run(
    "UPDATE demo_videos SET title = (SELECT title FROM demo_artwork WHERE video_id = 1) WHERE id = 1"
  );
});

describe("demo artwork fixtures", () => {
  test("provides the complete artwork contract for curated demo videos", () => {
    const artwork = demoArtworkService.getByVideoId(1);
    expect(() => videoArtworkSchema.parse(artwork)).not.toThrow();
    expect(artwork.status).toBe("ready");
    expect(artwork.palette?.dominant).toMatch(/^#[a-f0-9]{6}$/);
    expect(artwork.assets.map((asset) => asset.variant).sort()).toEqual([
      "card",
      "hero",
      "poster",
      "square",
      "title",
    ]);

    const title = artwork.assets.find((asset) => asset.variant === "title");
    expect(title).toMatchObject({
      source_timestamp_seconds: null,
      crop: null,
      focal_point: null,
      safe_area: null,
      bottom_luma: null,
      effects: ["title"],
    });
  });

  test("hides title artwork after the video is renamed", () => {
    getDemoSqlite().run("UPDATE demo_videos SET title = ? WHERE id = 1", [
      "Renamed video",
    ]);
    expect(
      demoArtworkService.getByVideoId(1).assets.map((asset) => asset.variant)
    ).not.toContain("title");
    expect(() => demoArtworkService.getAssetById(15)).toThrow();
  });

  test("reuses safe raster fixtures without assigning stale titles to expanded videos", () => {
    const source = demoRepository.getVideoById(1);
    const expanded = demoRepository.getVideoById(45);
    expect(expanded.thumbnail.file_path).toBe(source.thumbnail.file_path);
    expect(expanded.title).not.toBe(source.title);

    const artwork = demoArtworkService.getByVideoId(45);
    expect(artwork.assets.map((asset) => asset.variant).sort()).toEqual([
      "card",
      "hero",
      "poster",
      "square",
    ]);
    expect(() => demoArtworkService.getAssetById(455)).toThrow();
  });

  test("returns summaries and resolves image ids only to demo_mode files", () => {
    const videoIds = demoRepository
      .getVideos({ limit: 200 })
      .data.map((video: { id: number }) => video.id);
    const summaries = demoArtworkService.getSummariesByVideoIds(videoIds);
    expect(summaries.size).toBe(videoIds.length);
    expect(summaries.get(1)).toMatchObject({
      urls: {
        card: expect.stringMatching(
          /^\/api\/artwork\/11\/image\?h=[a-f0-9]{16}$/
        ),
        title: expect.stringMatching(
          /^\/api\/artwork\/15\/image\?h=[a-f0-9]{16}$/
        ),
      },
      palette: { dominant: expect.stringMatching(/^#[a-f0-9]{6}$/) },
    });

    const card = demoArtworkService.getAssetById(11);
    expect(isDemoAssetPath(card.filePath)).toBeTrue();
    expect(existsSync(card.filePath)).toBeTrue();
    expect(card.variant).toBe("card");
  });
});
