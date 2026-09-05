import { beforeAll, describe, expect, it } from "bun:test";
import { useSeededDemoDatabase } from "./helpers/demo-database";
import {
  videoListResponseSchema,
  videoResponseSchema,
} from "@/modules/videos/videos.schemas";
import { creatorListResponseSchema } from "@/modules/creators/creators.schemas";

useSeededDemoDatabase();
let demo: typeof import("@/database/demo");
beforeAll(async () => { demo = await import("@/database/demo"); });

describe("SQLite demo repository", () => {
  it("imports the relationship-rich seed and materializes pagination rows", () => {
    const sqlite = demo.getDemoSqlite();
    const count = (table: string) =>
      Number(
        (
          sqlite.query(`SELECT count(*) AS count FROM ${table}`).get() as {
            count: number;
          }
        ).count
      );

    expect(count("demo_videos")).toBe(132);
    expect(count("demo_creators")).toBe(42);
    expect(count("demo_studios")).toBe(21);
    expect(count("demo_tags")).toBe(46);
    expect(count("demo_storyboards")).toBe(132);
    expect(count("demo_creator_studios")).toBeGreaterThan(0);
  });

  it("preserves list/detail response contracts", () => {
    const videos = demo.demoRepository.getVideos({ page: 6, limit: 24 });
    expect(videos.pagination.total).toBe(132);
    expect(videos.data).toHaveLength(12);
    expect(
      videoListResponseSchema.safeParse({
        success: true,
        data: videos.data,
        pagination: videos.pagination,
      }).success
    ).toBe(true);

    const video = demo.demoRepository.getVideoById(1);
    expect(
      videoResponseSchema.safeParse({ success: true, data: video }).success
    ).toBe(true);

    const creators = demo.demoRepository.getCreators({ limit: 100 });
    expect(
      creatorListResponseSchema.safeParse({
        success: true,
        data: creators.data,
        pagination: creators.pagination,
      }).success
    ).toBe(true);
  });

  it("persists mutable state after closing and reopening SQLite", () => {
    demo.demoRepository.addFavoriteVideo(1);
    const playlist = demo.demoRepository.createPlaylist(1, {
      name: "Persistent demo playlist",
    });
    demo.demoRepository.addVideoToPlaylist(playlist.id, 1, 1);
    const bookmark = demo.demoRepository.createBookmark(1, 1, {
      timestamp_seconds: 12,
      name: "Persistent bookmark",
    });

    demo.closeDemoDatabase();

    expect(demo.demoRepository.isFavoriteVideo(1)).toBe(true);
    expect(demo.demoRepository.getPlaylistVideos(playlist.id, 1)).toHaveLength(
      1
    );
    expect(demo.demoRepository.findBookmarkById(bookmark.id)?.name).toBe(
      "Persistent bookmark"
    );
  });

  it("supports persisted generic resources for operational simulations", () => {
    demo.demoRepository.putResource("conversion-job", 77, {
      id: 77,
      status: "completed",
    });
    demo.closeDemoDatabase();
    expect(demo.demoRepository.getResource("conversion-job", 77)).toEqual({
      id: 77,
      status: "completed",
    });
  });
});
