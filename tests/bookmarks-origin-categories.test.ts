import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { existsSync, unlinkSync } from "node:fs";

process.env.NODE_ENV = "test";
process.env.POSTGRES_HOST = "127.0.0.1";
process.env.POSTGRES_USER = "test_user";
process.env.POSTGRES_PASSWORD = "test_password";
process.env.POSTGRES_DB = "conversor_video_test";
process.env.SESSION_SECRET ||=
  "bookmark-test-session-secret-with-at-least-32-characters";

let env: typeof import("@/config/env").env;
let closeDemoDatabase: typeof import("@/database/demo").closeDemoDatabase;
let demoSchema: typeof import("@/database/demo").demoSchema;
let getDemoDatabase: typeof import("@/database/demo").getDemoDatabase;
let initializeDemoDatabase: typeof import("@/database/demo").initializeDemoDatabase;
let setDemoDatabasePathForTests: typeof import("@/database/demo").setDemoDatabasePathForTests;
let bookmarkCategoriesService: typeof import("@/modules/bookmarks/bookmark-categories.service").bookmarkCategoriesService;
let bookmarkListQuerySchema: typeof import("@/modules/bookmarks/bookmarks.schemas").bookmarkListQuerySchema;
let createBookmarkSchema: typeof import("@/modules/bookmarks/bookmarks.schemas").createBookmarkSchema;
let bookmarksService: typeof import("@/modules/bookmarks/bookmarks.service").bookmarksService;

const databasePath = `/tmp/conversor-video-bookmarks-${process.pid}.sqlite`;
const timestamp = "2026-08-28T12:00:00.000Z";
let originalDemoMode: boolean;

beforeAll(async () => {
  ({ env } = await import("@/config/env"));
  ({
    closeDemoDatabase,
    demoSchema,
    getDemoDatabase,
    initializeDemoDatabase,
    setDemoDatabasePathForTests,
  } = await import("@/database/demo"));
  ({ bookmarkCategoriesService } =
    await import("@/modules/bookmarks/bookmark-categories.service"));
  ({ bookmarkListQuerySchema, createBookmarkSchema } =
    await import("@/modules/bookmarks/bookmarks.schemas"));
  ({ bookmarksService } =
    await import("@/modules/bookmarks/bookmarks.service"));
  originalDemoMode = env.DEMO_MODE;
});

function removeDatabaseFiles(): void {
  closeDemoDatabase();
  for (const suffix of ["", "-shm", "-wal"]) {
    const path = `${databasePath}${suffix}`;
    if (existsSync(path)) unlinkSync(path);
  }
}

function seedVideo(): void {
  initializeDemoDatabase();
  getDemoDatabase()
    .insert(demoSchema.demoVideosTable)
    .values({
      id: 1,
      sourceVideoId: 1,
      filePath: "demo_mode/video/bookmarks.webm",
      fileName: "bookmarks.webm",
      directoryId: 1,
      fileSizeBytes: 100,
      durationSeconds: 300,
      title: "Bookmarks",
      isAvailable: true,
      indexedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .run();
}

beforeEach(() => {
  env.DEMO_MODE = true;
  setDemoDatabasePathForTests(databasePath);
  removeDatabaseFiles();
  seedVideo();
});

afterEach(() => {
  removeDatabaseFiles();
  env.DEMO_MODE = originalDemoMode;
});

afterAll(() => setDemoDatabasePathForTests(null));

describe("bookmark origin and category contract", () => {
  test("keeps manual creation as the only public provenance", () => {
    expect(
      createBookmarkSchema.parse({ timestamp_seconds: 12, name: "Moment" })
    ).toEqual({ timestamp_seconds: 12, name: "Moment" });
    expect(
      createBookmarkSchema.safeParse({
        timestamp_seconds: 12,
        name: "Moment",
        origin: "automatic",
      }).success
    ).toBe(false);
  });

  test("validates complete intervals and list filters", () => {
    expect(
      createBookmarkSchema.safeParse({
        timestamp_seconds: 12,
        end_timestamp_seconds: 20,
        name: "Incomplete",
      }).success
    ).toBe(false);
    expect(
      createBookmarkSchema.safeParse({
        timestamp_seconds: 12,
        peak_timestamp_seconds: 17,
        end_timestamp_seconds: 20,
        name: "Episode",
      }).success
    ).toBe(true);
    expect(bookmarkListQuerySchema.parse({})).toEqual({});
    expect(bookmarkListQuerySchema.safeParse({ origin: "all" }).success).toBe(
      false
    );
    expect(
      createBookmarkSchema.safeParse({
        timestamp_seconds: 12,
        name: "Duplicate categories",
        category_ids: [1, 1],
      }).success
    ).toBe(false);
    expect(
      bookmarkListQuerySchema.parse({
        origin: "automatic",
        category: "BUTTOCKS_EXPOSED",
      })
    ).toEqual({ origin: "automatic", category: "BUTTOCKS_EXPOSED" });
  });

  test("seeds the exact protected system taxonomy", async () => {
    const categories = await bookmarkCategoriesService.list(7);

    expect(categories.map(({ key }) => key)).toEqual([
      "ANUS_COVERED",
      "ANUS_EXPOSED",
      "ARMPITS_EXPOSED",
      "BELLY_EXPOSED",
      "BUTTOCKS_EXPOSED",
      "FEET_EXPOSED",
      "FEMALE_BREAST_EXPOSED",
      "FEMALE_GENITALIA_COVERED",
      "FEMALE_GENITALIA_EXPOSED",
      "MALE_BREAST_EXPOSED",
      "MALE_GENITALIA_EXPOSED",
    ]);
    expect(
      categories.every(
        ({ kind, user_id }) => kind === "system" && user_id === null
      )
    ).toBe(true);
    await expect(
      bookmarkCategoriesService.update(categories[0]!.id, 7, {
        name: "Renamed",
      })
    ).rejects.toThrow("System bookmark categories cannot be modified");
    await expect(
      bookmarkCategoriesService.delete(categories[0]!.id, 7)
    ).rejects.toThrow("System bookmark categories cannot be deleted");
  });

  test("enforces custom-category ownership", async () => {
    const category = await bookmarkCategoriesService.create(7, {
      key: "favorite-angle",
      name: "Favorite angle",
    });

    expect(category).toMatchObject({
      key: "favorite-angle",
      name: "Favorite angle",
      kind: "custom",
      user_id: 7,
    });
    await expect(
      bookmarkCategoriesService.update(category.id, 8, { name: "Stolen" })
    ).rejects.toThrow("permission");
    await expect(
      bookmarkCategoriesService.delete(category.id, 8)
    ).rejects.toThrow("permission");
  });

  test("rejects unowned assignments without replacing current categories", async () => {
    const owned = await bookmarkCategoriesService.create(7, {
      key: "owned-category",
      name: "Owned",
    });
    const foreign = await bookmarkCategoriesService.create(8, {
      key: "foreign-category",
      name: "Foreign",
    });
    const bookmark = await bookmarksService.create(1, 7, {
      timestamp_seconds: 12,
      name: "Protected assignments",
      category_ids: [owned.id],
    });

    await expect(
      bookmarksService.update(bookmark.id, 7, {
        category_ids: [foreign.id],
      })
    ).rejects.toThrow("unavailable");
    expect(
      (await bookmarksService.findById(bookmark.id)).categories.map(
        ({ id }) => id
      )
    ).toEqual([owned.id]);
  });

  test("assigns many categories and filters bookmarks by origin and category", async () => {
    const system = await bookmarkCategoriesService.list(7);
    const manual = await bookmarksService.create(1, 7, {
      timestamp_seconds: 12,
      peak_timestamp_seconds: 17,
      end_timestamp_seconds: 20,
      name: "Episode",
      category_ids: [system[0]!.id, system[1]!.id],
    });
    getDemoDatabase()
      .insert(demoSchema.demoBookmarksTable)
      .values({
        videoId: 1,
        userId: 7,
        timestampSeconds: 40,
        endTimestampSeconds: 50,
        peakTimestampSeconds: 45,
        origin: "automatic",
        analysisRunId: 99,
        name: "Automatic episode",
        description: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .run();

    expect(manual).toMatchObject({
      origin: "manual",
      end_timestamp_seconds: 20,
      peak_timestamp_seconds: 17,
      analysis_run_id: null,
      user_modified_at: null,
      is_user_edited: false,
    });
    expect(manual.categories.map(({ key }) => key)).toEqual([
      "ANUS_COVERED",
      "ANUS_EXPOSED",
    ]);
    expect(
      await bookmarksService.getBookmarksForVideo(1, 7, { origin: "manual" })
    ).toHaveLength(1);
    expect(
      await bookmarksService.getBookmarksForVideo(1, 7, {
        origin: "automatic",
      })
    ).toHaveLength(1);
    expect(
      await bookmarksService.getBookmarksForVideo(1, 7, {
        origin: "all",
        category: "ANUS_EXPOSED",
      })
    ).toEqual([manual]);
  });

  test("marks an automatic bookmark as user-edited", async () => {
    const row = getDemoDatabase()
      .insert(demoSchema.demoBookmarksTable)
      .values({
        videoId: 1,
        userId: 7,
        timestampSeconds: 40,
        endTimestampSeconds: 50,
        peakTimestampSeconds: 45,
        origin: "automatic",
        analysisRunId: 99,
        name: "Automatic episode",
        description: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .returning({ id: demoSchema.demoBookmarksTable.id })
      .get();

    const updated = await bookmarksService.update(row.id, 7, {
      name: "Kept by user",
    });

    expect(updated.is_user_edited).toBe(true);
    expect(updated.user_modified_at).not.toBeNull();
  });

  test("marks linked automatic bookmarks before deleting a custom category", async () => {
    const category = await bookmarkCategoriesService.create(7, {
      key: "custom-review",
      name: "Custom review",
    });
    const bookmark = getDemoDatabase()
      .insert(demoSchema.demoBookmarksTable)
      .values({
        videoId: 1,
        userId: 7,
        timestampSeconds: 40,
        endTimestampSeconds: 50,
        peakTimestampSeconds: 45,
        origin: "automatic",
        analysisRunId: 99,
        name: "Automatic episode",
        description: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .returning({ id: demoSchema.demoBookmarksTable.id })
      .get();
    getDemoDatabase()
      .insert(demoSchema.demoBookmarkCategoryAssignmentsTable)
      .values({ bookmarkId: bookmark.id, categoryId: category.id })
      .run();

    await bookmarkCategoriesService.delete(category.id, 7);

    expect((await bookmarksService.findById(bookmark.id)).is_user_edited).toBe(
      true
    );
  });
});
