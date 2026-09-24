import { existsSync } from "fs";
import { beforeAll, describe, expect, it } from "bun:test";
import { useSeededDemoDatabase } from "./helpers/demo-database";
import {
  duplicatesResponseSchema,
  unavailableVideosResponseSchema,
  videoListResponseSchema,
  videoResponseSchema,
} from "@/modules/videos/videos.schemas";
import { videosDemoService } from "@/modules/videos/videos.demo.service";
import { creatorListResponseSchema, creatorResponseSchema } from "@/modules/creators/creators.schemas";
import { creatorsDemoService } from "@/modules/creators/creators.demo.service";

useSeededDemoDatabase();
let demo: typeof import("@/database/demo");
beforeAll(async () => {
  demo = await import("@/database/demo");
});

describe("SQLite demo repository", () => {
  it("exposes matching real source facts in isolated demo creator records", () => {
    const sqlite = demo.getDemoSqlite();
    sqlite.exec("SAVEPOINT source_metadata_showcase");
    try {
      demo.prepareDemoDatabaseForStartup("manual");
      const creator = creatorsDemoService.findById(1719);
      const response = creatorResponseSchema.parse({ success: true, data: creator });
      expect(response.data.name).toBe("Larkin Love");
      expect(response.data.birth_date).toBe("1985-10-31");
      expect(response.data.height_cm).toBe(165);
      expect(response.data.external_ids?.[0]?.source).toBe("theporndb");
      expect(response.data.profile_picture_path).toContain("1719-portrait.webp");
      expect(response.data.main_picture_path).toContain("1719-main.webp");
      expect(existsSync(response.data.profile_picture_path!)).toBe(true);
      expect(existsSync(response.data.main_picture_path!)).toBe(true);
      expect(response.data.profile_picture_url).toBe("/api/creators/1719/picture");
      expect(response.data.main_picture_url).toBe("/api/creators/1719/picture?variant=main");
      expect(response.data.release_years).toBeUndefined();
      expect(creatorsDemoService.findById(1584).birth_date).toBe("2000");
    } finally {
      sqlite.exec("ROLLBACK TO SAVEPOINT source_metadata_showcase");
      sqlite.exec("RELEASE SAVEPOINT source_metadata_showcase");
    }
  });
  it("provides missing-source examples that remain missing after verification", () => {
    const result = videosDemoService.listUnavailable({ page: 1, limit: 20 });
    expect(result.pagination.total).toBe(3);
    expect(result.data.map((video) => video.id)).toEqual([130, 131, 132]);
    expect(
      unavailableVideosResponseSchema.safeParse({ success: true, ...result })
        .success
    ).toBe(true);

    demo.getDemoSqlite().exec("SAVEPOINT missing_video_verification");
    try {
      expect(videosDemoService.verifyAvailability({ videoId: 130 })).toEqual({
        checked: 1,
        now_available: 0,
        still_missing: 1,
      });
    } finally {
      demo
        .getDemoSqlite()
        .exec("ROLLBACK TO SAVEPOINT missing_video_verification");
      demo.getDemoSqlite().exec("RELEASE SAVEPOINT missing_video_verification");
    }
  });

  it("adds missing examples to an older demo catalog only once", () => {
    const sqlite = demo.getDemoSqlite();
    sqlite.exec("SAVEPOINT missing_video_upgrade");
    try {
      sqlite.exec(
        "DELETE FROM demo_meta WHERE key = 'missing_video_examples_v1'"
      );
      sqlite.exec(`
        UPDATE demo_videos
        SET file_path = (
          SELECT source.file_path FROM demo_videos source
          WHERE source.id = demo_videos.source_video_id
        ), is_available = 1
        WHERE id IN (130, 131, 132)
      `);

      demo.prepareDemoDatabaseForStartup("manual");
      expect(
        videosDemoService.listUnavailable({ page: 1, limit: 20 }).pagination
          .total
      ).toBe(3);

      sqlite.exec("DELETE FROM demo_videos WHERE id = 130");
      demo.prepareDemoDatabaseForStartup("manual");
      expect(
        videosDemoService.listUnavailable({ page: 1, limit: 20 }).pagination
          .total
      ).toBe(2);
    } finally {
      sqlite.exec("ROLLBACK TO SAVEPOINT missing_video_upgrade");
      sqlite.exec("RELEASE SAVEPOINT missing_video_upgrade");
    }
  });

  it("serves duplicate examples from both fresh and older demo catalogs", () => {
    const sqlite = demo.getDemoSqlite();
    sqlite.exec("SAVEPOINT duplicate_examples");
    try {
      sqlite.exec(`
        UPDATE demo_videos
        SET file_hash = 'example-' || source_video_id || '-' || id
        WHERE source_video_id IN (1, 2, 3)
      `);
      sqlite.exec(`
        UPDATE demo_videos SET file_hash = 'example-' || id
        WHERE id IN (1, 2, 3)
      `);
      const olderCatalog = videosDemoService.getDuplicates();
      expect(olderCatalog).toHaveLength(3);
      expect(olderCatalog.map((group) => group.count)).toEqual([3, 3, 3]);
      expect(
        duplicatesResponseSchema.safeParse({
          success: true,
          data: olderCatalog,
        }).success
      ).toBe(true);

      sqlite.exec(`
        UPDATE demo_videos SET file_hash = 'example-' || source_video_id
        WHERE source_video_id IN (1, 2, 3)
      `);
      const freshCatalog = videosDemoService.getDuplicates();
      expect(freshCatalog).toHaveLength(3);
      expect(freshCatalog.map((group) => group.count)).toEqual([3, 3, 3]);
      expect(
        duplicatesResponseSchema.safeParse({
          success: true,
          data: freshCatalog,
        }).success
      ).toBe(true);
    } finally {
      sqlite.exec("ROLLBACK TO SAVEPOINT duplicate_examples");
      sqlite.exec("RELEASE SAVEPOINT duplicate_examples");
    }
  });

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
    expect(videos.pagination.total).toBe(129);
    expect(videos.data).toHaveLength(9);
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
