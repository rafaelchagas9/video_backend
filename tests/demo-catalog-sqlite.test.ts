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
  demoRepository,
  getDemoDatabase,
  initializeDemoDatabase,
  setDemoDatabasePathForTests,
} from "@/database/demo";
import {
  DirectoriesDemoService,
  directoriesDemoService,
} from "@/modules/directories/directories.demo.service";
import { directoriesService } from "@/modules/directories/directories.service";
import { videosDemoService } from "@/modules/videos/videos.demo.service";
import { videosBulkService } from "@/modules/videos/videos.bulk.service";
import { videosMetadataService } from "@/modules/videos/videos.metadata.service";
import { videosService } from "@/modules/videos/videos.service";
import { tagsService } from "@/modules/tags/tags.service";
import { studiosService } from "@/modules/studios/studios.service";
import { studioAssignmentDemoService } from "@/modules/studios/studio-assignment.demo.service";
import { triageDemoService } from "@/modules/triage/triage.demo.service";
import { ConflictError, NotFoundError } from "@/utils/errors";

const databasePath = `/tmp/conversor-video-demo-catalog-${process.pid}.sqlite`;
const timestamp = "2026-01-01T00:00:00.000Z";
const originalProcessNodeEnv = process.env.NODE_ENV;
const originalEnvNodeEnv = env.NODE_ENV;
const originalDemoMode = env.DEMO_MODE;

process.env.NODE_ENV = "test";
env.NODE_ENV = "test";

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
  db.insert(demoSchema.demoTagCategoriesTable)
    .values([
      {
        id: 1,
        name: "Genre",
        group: "Content",
        description: "Genres",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      {
        id: 2,
        name: "Theme",
        group: "Content",
        description: "Themes",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ])
    .run();
  db.insert(demoSchema.demoTagsTable)
    .values([
      {
        id: 1,
        name: "Demo Tag",
        parentId: null,
        categoryId: 1,
        description: null,
        color: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      {
        id: 2,
        name: "Nested Tag",
        parentId: 1,
        categoryId: 2,
        description: null,
        color: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      {
        id: 3,
        name: "Sibling Tag",
        parentId: 1,
        categoryId: 1,
        description: null,
        color: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ])
    .run();
  db.insert(demoSchema.demoTagAliasesTable)
    .values({
      id: 1,
      tagId: 2,
      name: "Hidden child",
      note: "Fixture alias",
      createdAt: timestamp,
    })
    .run();
  db.insert(demoSchema.demoStudiosTable)
    .values([
      {
        id: 1,
        name: "Demo Studio",
        description: null,
        profilePicturePath: null,
        parentStudioId: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      {
        id: 2,
        name: "Child Studio A",
        description: null,
        profilePicturePath: null,
        parentStudioId: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      {
        id: 3,
        name: "Child Studio B",
        description: null,
        profilePicturePath: null,
        parentStudioId: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ])
    .run();
  db.insert(demoSchema.demoStudioAliasesTable)
    .values({
      id: 1,
      studioId: 2,
      name: "Alternate studio",
      note: null,
      createdAt: timestamp,
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

afterAll(() => {
  setDemoDatabasePathForTests(null);
  env.NODE_ENV = originalEnvNodeEnv;
  if (originalProcessNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalProcessNodeEnv;
});

describe("SQLite demo catalog adapters", () => {
  test("exposes navigable taxonomy with alias-aware search and tree parity", async () => {
    expect(await tagsService.listCategories()).toEqual([
      expect.objectContaining({ name: "Genre", group: "Content", tag_count: 2 }),
      expect.objectContaining({ name: "Theme", group: "Content", tag_count: 1 }),
    ]);

    const tagResult = await tagsService.list({
      search: "hidden child",
      tree: true,
      include: ["category", "aliases"],
    });
    expect(tagResult.pagination.total).toBe(1);
    expect(tagResult.data[0]).toMatchObject({
      id: 1,
      children: [
        {
          id: 2,
          category: { name: "Theme" },
          aliases: [{ name: "Hidden child", note: "Fixture alias" }],
        },
        { id: 3 },
      ],
    });

    const categoryTree = await tagsService.list({
      category_id: 2,
      tree: true,
    });
    expect(categoryTree.data[0]).toMatchObject({
      id: 1,
      children: [{ id: 2 }, { id: 3 }],
    });

    const studioResult = await studiosService.list({
      search: "alternate studio",
      include: ["hierarchy", "aliases"],
    });
    expect(studioResult.data).toEqual([
      expect.objectContaining({
        id: 2,
        parent: { id: 1, name: "Demo Studio" },
        children: [],
        aliases: [expect.objectContaining({ name: "Alternate studio" })],
      }),
    ]);
    expect(
      await studiosService.findById(1, ["hierarchy", "aliases"])
    ).toMatchObject({
      parent: null,
      children: [
        { id: 2, name: "Child Studio A" },
        { id: 3, name: "Child Studio B" },
      ],
      aliases: [],
    });

    expect(
      await studiosService.list({ sort: "name", order: "desc", limit: 1 })
    ).toMatchObject({
      data: [{ id: 1, name: "Demo Studio" }],
      pagination: { page: 1, limit: 1, total: 3, totalPages: 3 },
    });

    getDemoDatabase()
      .update(demoSchema.demoStudiosTable)
      .set({ parentStudioId: 2 })
      .where(eq(demoSchema.demoStudiosTable.id, 1))
      .run();
    expect(await studiosService.findById(1, ["hierarchy"])).toMatchObject({
      parent: null,
      children: [{ id: 3, name: "Child Studio B" }],
    });
    expect(await studiosService.findById(2, ["hierarchy"])).toMatchObject({
      parent: null,
      children: [],
    });
    getDemoDatabase()
      .update(demoSchema.demoStudiosTable)
      .set({ parentStudioId: null })
      .where(eq(demoSchema.demoStudiosTable.id, 1))
      .run();

    await studiosService.delete(1);
    expect(
      getDemoDatabase()
        .select({ parentStudioId: demoSchema.demoStudiosTable.parentStudioId })
        .from(demoSchema.demoStudiosTable)
        .where(eq(demoSchema.demoStudiosTable.id, 2))
        .get()
    ).toEqual({ parentStudioId: null });
  });

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

  test("tracks explicit studio assignment transitions", () => {
    expect(demoRepository.getVideoById(2).studio_assignment_status).toBe("unknown");
    studioAssignmentDemoService.confirmNone([2]);
    expect(demoRepository.getVideoById(2).studio_assignment_status).toBe("confirmed_none");
    studioAssignmentDemoService.linkMany([2], [1]);
    expect(demoRepository.getVideoById(2).studio_assignment_status).toBe("assigned");
    expect(() => studioAssignmentDemoService.confirmNone([2])).toThrow();
    studioAssignmentDemoService.unlinkMany([2], [1]);
    expect(demoRepository.getVideoById(2).studio_assignment_status).toBe("unknown");
  });

  test("rejects missing demo videos before mutating any valid target", () => {
    studioAssignmentDemoService.confirmNone([2]);

    expect(() => studioAssignmentDemoService.linkMany([2, 999], [1]))
      .toThrow(NotFoundError);
    expect(demoRepository.getVideoById(2).studio_assignment_status).toBe(
      "confirmed_none"
    );
    expect(
      getDemoDatabase().select().from(demoSchema.demoVideoStudiosTable).all()
    ).toHaveLength(0);
  });

  test("reports actual studio rows changed by triage bulk actions", async () => {
    const added = await triageDemoService.applyBulkActions({
      videoIds: [1, 2],
      actions: { addStudioIds: [1, 1] },
    });
    expect(added.details.studios_added).toBe(2);

    const addedAgain = await triageDemoService.applyBulkActions({
      videoIds: [1, 2],
      actions: { addStudioIds: [1] },
    });
    expect(addedAgain.details.studios_added).toBe(0);

    const removed = await triageDemoService.applyBulkActions({
      videoIds: [1, 2],
      actions: { removeStudioIds: [1, 1] },
    });
    expect(removed.details.studios_removed).toBe(2);

    const removedAgain = await triageDemoService.applyBulkActions({
      videoIds: [1, 2],
      actions: { removeStudioIds: [1] },
    });
    expect(removedAgain.details.studios_removed).toBe(0);
  });

  test("rejects and rolls back triage confirmed-none when any video is linked", async () => {
    studioAssignmentDemoService.linkMany([1], [1]);

    await expect(triageDemoService.applyBulkActions({
      videoIds: [1, 2],
      actions: {
        addCreatorIds: [1],
        studioAssignmentStatus: "confirmed_none",
      },
    })).rejects.toBeInstanceOf(ConflictError);

    expect(
      getDemoDatabase().select().from(demoSchema.demoVideoCreatorsTable).all()
    ).toHaveLength(0);
    expect(demoRepository.getVideoById(2).studio_assignment_status).toBe("unknown");
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

  test("persists deterministic scan history and rejects an overlapping start", async () => {
    const service = new DirectoriesDemoService();
    const seeded = service.listScanRuns(1, 1, 20);
    expect(seeded.data.map((run) => run.id)).toEqual([2, 1]);

    const first = service.startScan(1);
    expect(() => service.startScan(1)).toThrow(
      "Directory scan already in progress"
    );
    expect(service.listScanRuns(1, 1, 20).pagination.total).toBe(3);
    await first.completion;

    const reloaded = new DirectoriesDemoService().findScanRun(1, first.run.id);
    expect(reloaded).toMatchObject({
      status: "completed",
      files_found: 2,
      files_added: 0,
      files_updated: 0,
      files_removed: 0,
      error_count: 0,
    });

    removeDatabaseFiles();
    seedCatalog();
    expect(new DirectoriesDemoService().listScanRuns(1, 1, 20).data.map((run) => run.id)).toEqual([2, 1]);
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
