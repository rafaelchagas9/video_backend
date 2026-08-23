import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { existsSync, unlinkSync } from "fs";
import { env } from "@/config/env";
import {
  closeDemoDatabase,
  demoSchema,
  demoRepository,
  getDemoDatabase,
  initializeDemoDatabase,
  setDemoDatabasePathForTests,
} from "@/database/demo";
import { bookmarksDemoService } from "@/modules/bookmarks/bookmarks.demo.service";
import { creatorsDemoService } from "@/modules/creators/creators.demo.service";
import { creatorsAliasesService } from "@/modules/creators/creators.aliases.service";
import { creatorsPlatformsService } from "@/modules/creators/creators.platforms.service";
import { creatorsRelationshipsService } from "@/modules/creators/creators.relationships.service";
import { creatorsSocialService } from "@/modules/creators/creators.social.service";
import { favoritesDemoService } from "@/modules/favorites/favorites.demo.service";
import { playlistsDemoService } from "@/modules/playlists/playlists.demo.service";
import { ratingsDemoService } from "@/modules/ratings/ratings.demo.service";
import { studiosDemoService } from "@/modules/studios/studios.demo.service";
import { studiosRelationshipsService } from "@/modules/studios/studios.relationships.service";
import { studiosSocialService } from "@/modules/studios/studios.social.service";
import { tagsDemoService } from "@/modules/tags/tags.demo.service";
import { tagsService } from "@/modules/tags/tags.service";

const databasePath = `/tmp/conversor-video-demo-content-${process.pid}.sqlite`;
const timestamp = "2026-01-01T00:00:00.000Z";
const originalDemoMode = env.DEMO_MODE;

function removeDatabaseFiles(): void {
  closeDemoDatabase();
  for (const suffix of ["", "-shm", "-wal"]) {
    const path = `${databasePath}${suffix}`;
    if (existsSync(path)) unlinkSync(path);
  }
}

function seed(): void {
  initializeDemoDatabase();
  getDemoDatabase()
    .insert(demoSchema.demoVideosTable)
    .values({
      id: 1,
      sourceVideoId: 1,
      filePath: "demo_mode/video/one.webm",
      fileName: "one.webm",
      directoryId: 1,
      fileSizeBytes: 100,
      durationSeconds: 100,
      title: "One",
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
  seed();
});

afterEach(() => {
  removeDatabaseFiles();
  env.DEMO_MODE = originalDemoMode;
});

afterAll(() => setDemoDatabasePathForTests(null));

describe("SQLite demo people and content adapters", () => {
  test("persists creator, studio, taxonomy, and relationship mutations", () => {
    const creator = creatorsDemoService.create({ name: "Creator A" });
    const alias = creatorsDemoService.addAlias(creator.id, { name: "Alias A" });
    const studio = studiosDemoService.create({ name: "Studio A" });
    studiosDemoService.linkCreator(studio.id, creator.id);
    studiosDemoService.linkVideo(studio.id, 1);
    const root = tagsDemoService.create({ name: "Root" });
    const child = tagsDemoService.create({ name: "Child", parent_id: root.id });

    expect(creatorsDemoService.getAliases(creator.id)).toEqual([alias]);
    expect(
      studiosDemoService.getCreators(studio.id).map(({ id }) => id)
    ).toEqual([creator.id]);
    expect(studiosDemoService.getVideoIds(studio.id)).toEqual([1]);
    expect(tagsDemoService.getDescendants(root.id).map(({ id }) => id)).toEqual(
      [child.id]
    );
    expect(() =>
      tagsDemoService.update(root.id, { parent_id: child.id })
    ).toThrow();
  });

  test("persists ratings, bookmarks, and favorites with ownership", () => {
    const rating = ratingsDemoService.addRating(1, {
      rating: 4,
      comment: "good",
    });
    ratingsDemoService.update(rating.id, { rating: 5 });
    const bookmark = bookmarksDemoService.create(1, 7, {
      timestamp_seconds: 12,
      name: "Scene",
    });
    bookmarksDemoService.update(bookmark.id, 7, { description: "Important" });
    favoritesDemoService.add(7, 1);

    expect(ratingsDemoService.getAverageRating(1)).toBe(5);
    expect(bookmarksDemoService.findById(bookmark.id).description).toBe(
      "Important"
    );
    expect(() => bookmarksDemoService.delete(bookmark.id, 8)).toThrow();
    expect(favoritesDemoService.isFavorite(7, 1)).toBe(true);
    expect(favoritesDemoService.list(7)[0]?.file_name).toBe("one.webm");
  });

  test("persists playlist membership and ordering", () => {
    getDemoDatabase()
      .insert(demoSchema.demoVideosTable)
      .values({
        id: 2,
        sourceVideoId: 2,
        filePath: "demo_mode/video/two.webm",
        fileName: "two.webm",
        directoryId: 1,
        fileSizeBytes: 200,
        title: "Two",
        isAvailable: true,
        indexedAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .run();
    const playlist = playlistsDemoService.create(3, { name: "Queue" });
    playlistsDemoService.addVideo(playlist.id, 3, 1);
    playlistsDemoService.addVideo(playlist.id, 3, 2);
    playlistsDemoService.reorderVideos(playlist.id, 3, [
      { video_id: 2, position: 0 },
      { video_id: 1, position: 1 },
    ]);

    expect(playlistsDemoService.findById(playlist.id).video_count).toBe(2);
    expect(
      playlistsDemoService.getVideos(playlist.id, 3).map((video) => video.id)
    ).toEqual([2, 1]);
    expect(() =>
      playlistsDemoService.update(playlist.id, 4, { name: "Denied" })
    ).toThrow();
  });

  test("selects delegated covers only from current demo members", () => {
    getDemoDatabase()
      .insert(demoSchema.demoVideosTable)
      .values([
        {
          id: 2,
          sourceVideoId: 2,
          filePath: "demo_mode/video/two.webm",
          fileName: "two.webm",
          directoryId: 1,
          fileSizeBytes: 200,
          title: "Two",
          isAvailable: true,
          indexedAt: timestamp,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        {
          id: 3,
          sourceVideoId: 3,
          filePath: "demo_mode/video/outsider.webm",
          fileName: "outsider.webm",
          directoryId: 1,
          fileSizeBytes: 300,
          title: "Outsider",
          isAvailable: true,
          indexedAt: timestamp,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ])
      .run();

    const playlist = playlistsDemoService.create(3, { name: "Cover queue" });
    playlistsDemoService.addVideo(playlist.id, 3, 1);
    playlistsDemoService.addVideo(playlist.id, 3, 2);
    expect(
      playlistsDemoService.update(playlist.id, 3, {
        artwork_source_video_id: 2,
      }).artwork_source_video_id
    ).toBe(2);
    expect(() =>
      playlistsDemoService.update(playlist.id, 3, {
        artwork_source_video_id: 3,
      })
    ).toThrow("Artwork source video must belong to this playlist");
    expect(() =>
      playlistsDemoService.update(playlist.id, 4, {
        artwork_source_video_id: 2,
      })
    ).toThrow();
    playlistsDemoService.reorderVideos(playlist.id, 3, [
      { video_id: 2, position: 0 },
      { video_id: 1, position: 1 },
    ]);
    expect(
      playlistsDemoService.findById(playlist.id, 3).artwork_source_video_id
    ).toBe(2);
    playlistsDemoService.removeVideo(playlist.id, 3, 2);
    expect(
      playlistsDemoService.findById(playlist.id, 3).artwork_source_video_id
    ).toBe(1);
    playlistsDemoService.removeVideo(playlist.id, 3, 1);
    expect(
      playlistsDemoService.findById(playlist.id, 3).artwork_source_video_id
    ).toBeNull();

    const collection = demoRepository.createCollection({
      title: "Cover collection",
      kind: "movie_series",
    });
    demoRepository.addCollectionEntry(collection.id, {
      video_id: 1,
      entry_kind: "movie",
      sequence_number: 1,
    });
    demoRepository.addCollectionEntry(collection.id, {
      video_id: 2,
      entry_kind: "movie",
      sequence_number: 2,
    });
    expect(
      demoRepository.updateCollection(collection.id, {
        artwork_source_video_id: 2,
      }).artwork_source_video_id
    ).toBe(2);
    expect(() =>
      demoRepository.updateCollection(collection.id, {
        artwork_source_video_id: 3,
      })
    ).toThrow("Artwork source video must belong to this collection");
    demoRepository.reorderCollectionEntries(collection.id, {
      entries: [
        { video_id: 2, sequence_number: 1 },
        { video_id: 1, sequence_number: 2 },
      ],
    });
    expect(
      demoRepository.getCollectionById(collection.id).artwork_source_video_id
    ).toBe(2);
    demoRepository.removeCollectionEntry(collection.id, 2);
    expect(
      demoRepository.getCollectionById(collection.id).artwork_source_video_id
    ).toBe(1);
    demoRepository.removeCollectionEntry(collection.id, 1);
    expect(
      demoRepository.getCollectionById(collection.id).artwork_source_video_id
    ).toBeNull();

    const empty = demoRepository.createCollection({
      title: "Empty collection",
      kind: "other",
    });
    expect(empty.artwork_source_video_id).toBeNull();
    expect(() =>
      demoRepository.updateCollection(empty.id, {
        artwork_source_video_id: 3,
      })
    ).toThrow("Artwork source video must belong to this collection");
  });

  test("serves real collection and playlist watch summaries", () => {
    getDemoDatabase()
      .insert(demoSchema.demoVideosTable)
      .values({
        id: 2,
        sourceVideoId: 2,
        filePath: "demo_mode/video/two.webm",
        fileName: "two.webm",
        directoryId: 1,
        fileSizeBytes: 200,
        durationSeconds: 200,
        title: "Two",
        isAvailable: true,
        indexedAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .run();
    getDemoDatabase()
      .insert(demoSchema.demoVideoStatsTable)
      .values([
        {
          userId: 3,
          videoId: 1,
          playCount: 1,
          totalWatchSeconds: 100,
          sessionWatchSeconds: 100,
          sessionPlayCounted: true,
          lastPositionSeconds: 95,
          lastPlayedAt: "2026-01-02T00:00:00.000Z",
          lastWatchAt: "2026-01-02T00:00:00.000Z",
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        {
          userId: 3,
          videoId: 2,
          playCount: 1,
          totalWatchSeconds: 40,
          sessionWatchSeconds: 40,
          sessionPlayCounted: true,
          lastPositionSeconds: 40,
          lastPlayedAt: "2026-01-03T00:00:00.000Z",
          lastWatchAt: "2026-01-03T00:00:00.000Z",
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ])
      .run();

    const playlist = playlistsDemoService.create(3, { name: "Progress" });
    playlistsDemoService.addVideo(playlist.id, 3, 1);
    playlistsDemoService.addVideo(playlist.id, 3, 2);
    playlistsDemoService.reorderVideos(playlist.id, 3, [
      { video_id: 2, position: 0 },
      { video_id: 1, position: 1 },
    ]);

    const playlistSummary = playlistsDemoService.findById(playlist.id, 3);
    expect(playlistSummary).toMatchObject({
      video_count: 2,
      watched_count: 1,
      runtime_seconds: 300,
      artwork_source_video_id: 1,
      resume: { video_id: 2, position_seconds: 40 },
      last_played_at: "2026-01-03T00:00:00.000Z",
    });
    expect(playlistsDemoService.getVideos(playlist.id, 3)).toEqual([
      expect.objectContaining({
        id: 2,
        duration_seconds: 200,
        watched: false,
        position_seconds: 40,
      }),
      expect.objectContaining({
        id: 1,
        duration_seconds: 100,
        watched: true,
        position_seconds: 95,
      }),
    ]);

    const collection = demoRepository.createCollection({
      title: "Progress collection",
      kind: "tv_series",
    });
    demoRepository.addCollectionEntry(collection.id, {
      video_id: 1,
      entry_kind: "episode",
      sequence_number: 1,
      season_number: 1,
      episode_number: 1,
    });
    const secondEntry = demoRepository.addCollectionEntry(collection.id, {
      video_id: 2,
      entry_kind: "episode",
      sequence_number: 2,
      season_number: 1,
      episode_number: 2,
    });
    expect(demoRepository.getCollectionById(collection.id, 3)).toMatchObject({
      entry_count: 2,
      watched_count: 1,
      runtime_seconds: 300,
      season_count: 1,
      artwork_source_video_id: 1,
      resume: {
        entry_id: secondEntry.id,
        video_id: 2,
        position_seconds: 40,
      },
      last_watched_at: "2026-01-03T00:00:00.000Z",
    });
    expect(demoRepository.listCollectionEntries(collection.id, 3)).toEqual([
      expect.objectContaining({
        video_id: 1,
        video: expect.objectContaining({
          duration_seconds: 100,
          watched: true,
          position_seconds: 95,
        }),
      }),
      expect.objectContaining({
        video_id: 2,
        video: expect.objectContaining({
          duration_seconds: 200,
          watched: false,
          position_seconds: 40,
        }),
      }),
    ]);
  });

  test("routes child service mutations through SQLite adapters", async () => {
    const creator = creatorsDemoService.create({ name: "Child Creator" });
    const studio = studiosDemoService.create({ name: "Child Studio" });
    const tag = tagsDemoService.create({ name: "Child Tag" });

    const alias = await creatorsAliasesService.addAlias(creator.id, {
      name: "Alias",
    });
    await creatorsAliasesService.updateAlias(
      alias.id,
      { note: "persisted" },
      creator.id
    );
    const platform = await creatorsPlatformsService.addPlatformProfile(
      creator.id,
      {
        platform_id: 1,
        username: "child",
        profile_url: "https://example.com/child",
        is_primary: true,
      }
    );
    await creatorsPlatformsService.updatePlatformProfile(
      platform.id,
      { username: "updated" },
      creator.id
    );
    const creatorLink = await creatorsSocialService.addSocialLink(creator.id, {
      platform_name: "Site",
      url: "https://example.com/creator",
    });
    await creatorsSocialService.updateSocialLink(
      creatorLink.id,
      { url: "https://example.com/creator-updated" },
      creator.id
    );
    const studioLink = await studiosSocialService.addSocialLink(studio.id, {
      platform_name: "Site",
      url: "https://example.com/studio",
    });
    await studiosSocialService.updateSocialLink(
      studioLink.id,
      { url: "https://example.com/studio-updated" },
      studio.id
    );

    await creatorsRelationshipsService.linkStudio(creator.id, studio.id);
    await creatorsRelationshipsService.addToVideo(1, creator.id);
    await studiosRelationshipsService.linkVideo(studio.id, 1);
    await tagsService.addToVideo(1, tag.id);

    expect((await creatorsAliasesService.getAliases(creator.id))[0]?.note).toBe(
      "persisted"
    );
    expect(
      (await creatorsPlatformsService.getPlatformProfiles(creator.id))[0]
        ?.username
    ).toBe("updated");
    expect(
      (await creatorsSocialService.getSocialLinks(creator.id))[0]?.url
    ).toContain("updated");
    expect(
      (await studiosSocialService.getSocialLinks(studio.id))[0]?.url
    ).toContain("updated");
    expect(
      (await creatorsRelationshipsService.getStudios(creator.id)).map(
        ({ id }) => id
      )
    ).toEqual([studio.id]);
    expect(studiosDemoService.getVideoIds(studio.id)).toEqual([1]);
    expect(
      (await tagsService.getTagsForVideo(1)).map(({ id }) => id)
    ).toContain(tag.id);

    await creatorsAliasesService.deleteAlias(alias.id, creator.id);
    await creatorsPlatformsService.deletePlatformProfile(
      platform.id,
      creator.id
    );
    await creatorsSocialService.deleteSocialLink(creatorLink.id, creator.id);
    await studiosSocialService.deleteSocialLink(studioLink.id, studio.id);
  });
});
