import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { existsSync, unlinkSync } from "fs";
import { eq } from "drizzle-orm";
import { env } from "@/config/env";
import {
  closeDemoDatabase,
  demoSchema,
  getDemoDatabase,
  initializeDemoDatabase,
  setDemoDatabasePathForTests,
} from "@/database/demo";
import { directoriesDemoService } from "@/modules/directories/directories.demo.service";
import { directoriesService } from "@/modules/directories/directories.service";
import { videosDemoService } from "@/modules/videos/videos.demo.service";
import { videosBulkService } from "@/modules/videos/videos.bulk.service";
import { videosMetadataService } from "@/modules/videos/videos.metadata.service";
import { videosService } from "@/modules/videos/videos.service";

const databasePath = `/tmp/conversor-video-demo-catalog-${process.pid}.sqlite`;
const timestamp = "2026-01-01T00:00:00.000Z";
const originalDemoMode = env.DEMO_MODE;

function removeDatabaseFiles(): void {
  closeDemoDatabase();
  for (const suffix of ["", "-shm", "-wal"]) {
    const path = `${databasePath}${suffix}`;
    if (existsSync(path)) unlinkSync(path);
  }
}

function seedCatalog(): void {
  initializeDemoDatabase();
  const db = getDemoDatabase();
  db.insert(demoSchema.demoTagsTable)
    .values({
      id: 1,
      name: "Demo Tag",
      parentId: null,
      description: null,
      color: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .run();
  db.insert(demoSchema.demoStudiosTable)
    .values({
      id: 1,
      name: "Demo Studio",
      description: null,
      profilePicturePath: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .run();
  db.insert(demoSchema.demoCreatorsTable)
    .values({
      id: 1,
      name: "Demo Creator",
      description: null,
      profilePicturePath: null,
      mainPicturePath: null,
      faceThumbnailPath: null,
      extraJson: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .run();
  db.insert(demoSchema.demoVideosTable)
    .values([
      {
        id: 1,
        sourceVideoId: 1,
        filePath: "demo_mode/video/one.webm",
        fileName: "one.webm",
        directoryId: 1,
        fileSizeBytes: 100,
        fileHash: "duplicate-hash",
        title: "One",
        isAvailable: true,
        indexedAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      {
        id: 2,
        sourceVideoId: 2,
        filePath: "demo_mode/video/two.webm",
        fileName: "two.webm",
        directoryId: 1,
        fileSizeBytes: 200,
        fileHash: "duplicate-hash",
        title: "Two",
        isAvailable: false,
        indexedAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ])
    .run();
}

beforeEach(() => {
  env.DEMO_MODE = true;
  setDemoDatabasePathForTests(databasePath);
  removeDatabaseFiles();
  seedCatalog();
});

afterEach(() => {
  removeDatabaseFiles();
  env.DEMO_MODE = originalDemoMode;
});

afterAll(() => setDemoDatabasePathForTests(null));

describe("SQLite demo catalog adapters", () => {
  test("persists video edits and arbitrary metadata", () => {
    videosDemoService.update(1, { title: "Updated Demo Title" });
    expect(
      getDemoDatabase()
        .select({ title: demoSchema.demoVideosTable.title })
        .from(demoSchema.demoVideosTable)
        .where(eq(demoSchema.demoVideosTable.id, 1))
        .get()
    ).toEqual({ title: "Updated Demo Title" });

    expect(videosDemoService.setMetadata(1, "source", "fixture")).toMatchObject(
      {
        video_id: 1,
        key: "source",
        value: "fixture",
      }
    );
    expect(videosDemoService.getMetadata(1)).toHaveLength(1);
    videosDemoService.deleteMetadata(1, "source");
    expect(videosDemoService.getMetadata(1)).toEqual([]);
  });

  test("persists relationship and favorite bulk mutations", () => {
    videosDemoService.updateRelationships([1, 2], "creators", [1], "replace");
    videosDemoService.updateRelationships([1], "studios", [1], "add");
    videosDemoService.updateRelationships([1], "tags", [1], "add");
    videosDemoService.bulkUpdateFavorites(1, [1, 2], "add");

    expect(
      getDemoDatabase().select().from(demoSchema.demoVideoCreatorsTable).all()
    ).toHaveLength(2);
    expect(
      getDemoDatabase().select().from(demoSchema.demoVideoStudiosTable).all()
    ).toHaveLength(1);
    expect(
      getDemoDatabase().select().from(demoSchema.demoVideoTagsTable).all()
    ).toHaveLength(1);
    expect(
      getDemoDatabase().select().from(demoSchema.demoFavoritesTable).all()
    ).toHaveLength(2);

    videosDemoService.bulkUpdateFavorites(1, [2], "remove");
    expect(
      getDemoDatabase().select().from(demoSchema.demoFavoritesTable).all()
    ).toHaveLength(1);
  });

  test("reports duplicates and persistently purges unavailable rows", () => {
    expect(videosDemoService.getDuplicates()).toMatchObject([
      { file_hash: "duplicate-hash", count: 2, total_size_bytes: "300" },
    ]);
    expect(
      videosDemoService.listUnavailable({ page: 1, limit: 10 }).pagination.total
    ).toBe(1);
    expect(videosDemoService.purgeUnavailable({ ids: [2] })).toEqual({
      deleted_count: 1,
      deleted_ids: [2],
    });
    expect(
      videosDemoService.listUnavailable({ page: 1, limit: 10 }).pagination.total
    ).toBe(0);
  });

  test("persists virtual directories and derives their catalog statistics", async () => {
    expect((await directoriesService.findById(1)).path).toBe("demo_mode/video");
    expect(await directoriesService.getStats(1)).toMatchObject({
      total_videos: 2,
      total_size_bytes: 300,
      available_videos: 1,
      unavailable_videos: 1,
    });

    const created = await directoriesService.create({
      path: "demo_mode/secondary",
      auto_scan: true,
      scan_interval_minutes: 15,
    });
    expect(
      (await directoriesService.update(created.id, { is_active: false }))
        .is_active
    ).toBe(false);
    expect(directoriesDemoService.virtualScan(1)).toMatchObject({
      files_found: 2,
      files_skipped: 2,
      errors: [],
    });
    expect(directoriesDemoService.findById(1).last_scan_at).not.toBeNull();
    await directoriesService.delete(created.id);
    expect(() => directoriesDemoService.findById(created.id)).toThrow();
  });

  test("routes core video services through SQLite adapters", async () => {
    expect(
      (await videosService.update(1, { title: "Service title" })).title
    ).toBe("Service title");
    await videosMetadataService.setMetadata(1, "source", "service");
    expect(await videosMetadataService.getMetadata(1)).toEqual([
      { key: "source", value: "service" },
    ]);
    await videosBulkService.bulkUpdateCreators({
      videoIds: [1],
      creatorIds: [1],
      action: "add",
    });
    await videosBulkService.bulkUpdateTags({
      videoIds: [1],
      tagIds: [1],
      action: "add",
    });
    await videosBulkService.bulkUpdateStudios({
      videoIds: [1],
      studioIds: [1],
      action: "add",
    });
    await videosBulkService.bulkUpdateFavorites(5, {
      videoIds: [1],
      isFavorite: true,
    });

    expect(
      getDemoDatabase().select().from(demoSchema.demoVideoCreatorsTable).all()
    ).toHaveLength(1);
    expect(
      getDemoDatabase().select().from(demoSchema.demoVideoTagsTable).all()
    ).toHaveLength(1);
    expect(
      getDemoDatabase().select().from(demoSchema.demoVideoStudiosTable).all()
    ).toHaveLength(1);
    expect(
      getDemoDatabase().select().from(demoSchema.demoFavoritesTable).all()
    ).toHaveLength(1);
    expect((await videosBulkService.getDuplicates())[0]).toMatchObject({
      file_hash: "duplicate-hash",
      count: 2,
    });
  });
});
