import { afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";

process.env.NODE_ENV = "test";
process.env.SESSION_SECRET =
  process.env.SESSION_SECRET ??
  "test-secret-key-for-testing-purposes-only-do-not-use-in-production";
process.env.POSTGRES_USER = process.env.POSTGRES_USER ?? "test";
process.env.POSTGRES_PASSWORD = process.env.POSTGRES_PASSWORD ?? "test";

const authenticatedUser = {
  id: 1,
  name: "Test User",
  email: "test@example.com",
  email_verified: true,
  image: null,
  username: "test",
  created_at: new Date(0).toISOString(),
  updated_at: new Date(0).toISOString(),
};

const canonicalVideoList = {
  data: [
    {
      id: 101,
      file_path: "/videos/one.mp4",
      file_name: "one.mp4",
      directory_id: 8,
      file_size_bytes: 1234,
      file_hash: "hash-101",
      duration_seconds: 91,
      width: 1920,
      height: 1080,
      codec: "h264",
      bitrate: 1200000,
      fps: 30,
      audio_codec: "aac",
      title: "Video One",
      description: null,
      themes: null,
      is_available: true,
      last_verified_at: null,
      indexed_at: "2026-05-29T00:00:00.000Z",
      created_at: "2026-05-28T00:00:00.000Z",
      updated_at: "2026-05-29T00:00:00.000Z",
      thumbnail_id: 77,
      thumbnail_url: "/api/thumbnails/77/image",
      is_favorite: false,
    },
  ],
  pagination: {
    page: 2,
    limit: 1,
    total: 4,
    totalPages: 4,
  },
};

const conversionJob = {
  id: 9,
  video_id: 12,
  status: "pending" as const,
  preset: "720p_h264",
  target_resolution: "1280x720",
  codec: "h264",
  delete_original: false,
  batch_id: null,
  output_path: null,
  output_size_bytes: null,
  progress_percent: 0,
  error_message: null,
  created_at: "2026-05-29T00:00:00.000Z",
  started_at: null,
  completed_at: null,
};

const conversionServiceMock = {
  createJob: mock(async () => conversionJob),
  bulkCreateJobs: mock(async () => [conversionJob]),
  getQueue: mock(async () => [{ video_id: 12, queue_position: 1 }]),
  listByVideoId: mock(async () => [conversionJob]),
  getHistory: mock(async () => []),
  getHistoryOverview: mock(async () => ({
    total_conversions: 3,
    total_original_size_bytes: 1000,
    total_output_size_bytes: 800,
    total_size_delta_bytes: -200,
    total_saved_bytes: 200,
    total_increased_bytes: 0,
    saved_count: 3,
    increased_count: 0,
    unchanged_count: 0,
    avg_size_change_percent: -20,
    avg_conversion_duration_ms: 2000,
  })),
  findById: mock(async () => conversionJob),
  cancel: mock(async () => ({ ...conversionJob, status: "cancelled" as const })),
  delete: mock(async () => undefined),
  getActiveConversions: mock(async () => []),
  clearQueue: mock(async () => ({ pendingCleared: 2, processingReset: 1 })),
  getQueueStatus: mock(async () => ({
    queueLength: 5,
    activeJobs: 1,
    isProcessing: true,
  })),
  getPresets: mock(() => [
    {
      id: "720p_h264",
      name: "720p H.264",
      description: "Test preset",
      targetWidth: 1280,
      codec: "h264",
      qp: 24,
      audioBitrate: "128k",
      container: "mkv",
    },
  ]),
};

const triageServiceMock = {
  saveProgress: mock(async () => undefined),
  getProgress: mock(async () => ({
    filter_key: "untagged",
    last_video_id: 101,
    processed_count: 10,
    total_count: 50,
    updated_at: "2026-05-29T00:00:00.000Z",
  })),
  applyBulkActions: mock(async () => ({
    processed: 2,
    errors: 0,
    details: {
      creators_added: 1,
      creators_removed: 0,
      tags_added: 2,
      tags_removed: 0,
      studios_added: 0,
      studios_removed: 0,
    },
  })),
  getStatistics: mock(async () => ({
    total_untagged_videos: 10,
    total_videos: 100,
    tagged_percentage: 90,
    recent_progress: {
      last_24h_processed: 3,
      last_7d_processed: 12,
      avg_daily_rate: 3,
    },
    filter_breakdown: [],
    top_directories: [],
  })),
};

const storageStatsServiceMock = {
  getCurrentStorageStats: mock(async () => ({
    total_video_size_bytes: 1000,
    total_video_count: 2,
    thumbnails_size_bytes: 10,
    storyboards_size_bytes: 20,
    profile_pictures_size_bytes: 0,
    converted_size_bytes: 0,
    faces_size_bytes: 0,
    database_size_bytes: 0,
    directory_breakdown: [],
    total_managed_size_bytes: 30,
  })),
  getStorageHistory: mock(async () => []),
  createStorageSnapshot: mock(async () => ({
    id: 1,
    total_video_size_bytes: 1000,
    total_video_count: 2,
    thumbnails_size_bytes: 10,
    storyboards_size_bytes: 20,
    profile_pictures_size_bytes: 0,
    converted_size_bytes: 0,
    faces_size_bytes: 0,
    database_size_bytes: 0,
    directory_breakdown: [],
    created_at: "2026-05-29T00:00:00.000Z",
  })),
};

const libraryStatsServiceMock = {
  getCurrentLibraryStats: mock(async () => ({
    total_video_count: 2,
    available_video_count: 2,
    unavailable_video_count: 0,
    total_size_bytes: 1000,
    average_size_bytes: 500,
    total_duration_seconds: 180,
    average_duration_seconds: 90,
    resolution_breakdown: [],
    codec_breakdown: [],
  })),
  getLibraryHistory: mock(async () => []),
  createLibrarySnapshot: mock(async () => ({
    id: 2,
    total_video_count: 2,
    available_video_count: 2,
    unavailable_video_count: 0,
    total_size_bytes: 1000,
    average_size_bytes: 500,
    total_duration_seconds: 180,
    average_duration_seconds: 90,
    resolution_breakdown: [],
    codec_breakdown: [],
    created_at: "2026-05-29T00:00:00.000Z",
  })),
};

const contentStatsServiceMock = {
  getCurrentContentStats: mock(async () => ({
    videos_without_tags: 1,
    videos_without_creators: 1,
    videos_without_ratings: 1,
    videos_without_thumbnails: 1,
    videos_without_storyboards: 1,
    total_tags: 3,
    total_creators: 4,
    total_studios: 2,
    total_playlists: 1,
    top_tags: [],
    top_creators: [],
  })),
  getContentHistory: mock(async () => []),
  createContentSnapshot: mock(async () => ({
    id: 3,
    videos_without_tags: 1,
    videos_without_creators: 1,
    videos_without_ratings: 1,
    videos_without_thumbnails: 1,
    videos_without_storyboards: 1,
    total_tags: 3,
    total_creators: 4,
    total_studios: 2,
    total_playlists: 1,
    top_tags: [],
    top_creators: [],
    created_at: "2026-05-29T00:00:00.000Z",
  })),
};

const usageStatsServiceMock = {
  getCurrentUsageStats: mock(async () => ({
    total_watch_time_seconds: 100,
    total_play_count: 5,
    unique_videos_watched: 2,
    videos_never_watched: 0,
    average_completion_rate: 0.8,
    top_watched: [],
    activity_by_hour: {},
  })),
  getUsageHistory: mock(async () => []),
  createUsageSnapshot: mock(async () => ({
    id: 4,
    total_watch_time_seconds: 100,
    total_play_count: 5,
    unique_videos_watched: 2,
    videos_never_watched: 0,
    average_completion_rate: 0.8,
    top_watched: [],
    activity_by_hour: {},
    created_at: "2026-05-29T00:00:00.000Z",
  })),
};

const thumbnailsServiceMock = {
  findById: mock(async (id: number) => ({
    id,
    video_id: 7,
    file_path: "/tmp/thumb.webp",
    file_size_bytes: 123,
    timestamp_seconds: 5,
    width: 320,
    height: 180,
    generated_at: "2026-05-29T00:00:00.000Z",
  })),
  generate: mock(async (videoId: number) => ({
    id: 42,
    video_id: videoId,
    file_path: "/tmp/thumb.webp",
    file_size_bytes: 123,
    timestamp_seconds: 5,
    width: 320,
    height: 180,
    generated_at: "2026-05-29T00:00:00.000Z",
  })),
  getByVideoId: mock(async (videoId: number) => [
    {
      id: 42,
      video_id: videoId,
      file_path: "/tmp/thumb.webp",
      file_size_bytes: 123,
      timestamp_seconds: 5,
      width: 320,
      height: 180,
      generated_at: "2026-05-29T00:00:00.000Z",
    },
  ]),
  delete: mock(async () => undefined),
};

const storyboardsServiceMock = {
  findByVideoId: mock(async (videoId: number) => ({
    id: 11,
    video_id: videoId,
    sprite_path: "/tmp/storyboard.webp",
    vtt_path: "/tmp/storyboard.vtt",
    tile_width: 192,
    tile_height: 108,
    tile_count: 10,
    interval_seconds: 6,
    sprite_size_bytes: 1024,
    generated_at: "2026-05-29T00:00:00.000Z",
  })),
  generate: mock(async (videoId: number) => ({
    id: 11,
    video_id: videoId,
    sprite_path: "/tmp/storyboard.webp",
    vtt_path: "/tmp/storyboard.vtt",
    tile_width: 192,
    tile_height: 108,
    tile_count: 10,
    interval_seconds: 6,
    sprite_size_bytes: 1024,
    generated_at: "2026-05-29T00:00:00.000Z",
  })),
  delete: mock(async () => undefined),
  getVttContent: mock(async () => "WEBVTT"),
  queueGenerate: mock(async () => undefined),
  getSpriteAsset: mock(async () => ({
    buffer: Buffer.from("sprite"),
    contentType: "image/webp",
  })),
};

const videosSearchServiceMock = {
  list: mock(async () => canonicalVideoList),
  getNextVideo: mock(async () => ({
    video: canonicalVideoList.data[0],
    meta: {
      remaining: 3,
      total_matching: 4,
      has_wrapped: false,
    },
  })),
  getTriageQueue: mock(async () => ({
    ids: [101, 102],
    total: 2,
  })),
};

const creatorsServiceMock = {
  findById: mock(async (id: number) => ({ id })),
};

const tagsServiceMock = {
  findById: mock(async (id: number) => ({ id })),
};

const studiosServiceMock = {
  findById: mock(async (id: number) => ({ id })),
};

beforeAll(() => {
  mock.module("@/modules/auth/auth.middleware", () => ({
    authenticateUser: async (request: { user?: typeof authenticatedUser }) => {
      request.user = authenticatedUser;
    },
    optionalAuth: async () => undefined,
  }));

  mock.module("@/modules/conversion/conversion.service", () => ({
    conversionService: conversionServiceMock,
  }));
  mock.module("@/modules/triage/triage.service", () => ({
    triageService: triageServiceMock,
  }));
  mock.module("@/modules/stats/stats.storage.service", () => ({
    storageStatsService: storageStatsServiceMock,
  }));
  mock.module("@/modules/stats/stats.library.service", () => ({
    libraryStatsService: libraryStatsServiceMock,
  }));
  mock.module("@/modules/stats/stats.content.service", () => ({
    contentStatsService: contentStatsServiceMock,
  }));
  mock.module("@/modules/stats/stats.usage.service", () => ({
    usageStatsService: usageStatsServiceMock,
  }));
  mock.module("@/modules/thumbnails/thumbnails.service", () => ({
    thumbnailsService: thumbnailsServiceMock,
  }));
  mock.module("@/modules/storyboards/storyboards.service", () => ({
    storyboardsService: storyboardsServiceMock,
  }));
  mock.module("@/modules/videos/videos.search.service", () => ({
    videosSearchService: videosSearchServiceMock,
  }));
  mock.module("@/modules/videos/videos.service", () => ({
    videosService: {},
  }));
  mock.module("@/modules/videos/videos.suggestions.service", () => ({
    videosSuggestionsService: {},
  }));
  mock.module("@/modules/videos/videos.metadata.service", () => ({
    videosMetadataService: {},
  }));
  mock.module("@/modules/videos/videos.bulk.service", () => ({
    videosBulkService: {},
  }));
  mock.module("@/modules/videos/videos.related.service", () => ({
    videosRelatedService: {},
  }));
  mock.module("@/modules/videos/streaming.service", () => ({
    streamingService: {},
  }));
  mock.module("@/modules/creators/creators.service", () => ({
    creatorsService: creatorsServiceMock,
  }));
  mock.module("@/modules/creators/creators.platforms.service", () => ({
    creatorsPlatformsService: {},
  }));
  mock.module("@/modules/creators/creators.social.service", () => ({
    creatorsSocialService: {},
  }));
  mock.module("@/modules/creators/creators.relationships.service", () => ({
    creatorsRelationshipsService: {},
  }));
  mock.module("@/modules/creators/creators.bulk.service", () => ({
    creatorsBulkService: {},
  }));
  mock.module("@/modules/studios/studios.service", () => ({
    studiosService: studiosServiceMock,
  }));
  mock.module("@/modules/studios/studios.social.service", () => ({
    studiosSocialService: {},
  }));
  mock.module("@/modules/studios/studios.relationships.service", () => ({
    studiosRelationshipsService: {},
  }));
  mock.module("@/modules/studios/studios.bulk.service", () => ({
    studiosBulkService: {},
  }));
  mock.module("@/modules/tags/tags.service", () => ({
    tagsService: tagsServiceMock,
  }));
  mock.module("@/modules/ratings/ratings.service", () => ({
    ratingsService: {},
  }));
  mock.module("@/modules/bookmarks/bookmarks.service", () => ({
    bookmarksService: {},
  }));
});

afterEach(() => {
  mock.restore();
  conversionServiceMock.createJob.mockClear();
  conversionServiceMock.bulkCreateJobs.mockClear();
  conversionServiceMock.getQueue.mockClear();
  conversionServiceMock.getHistoryOverview.mockClear();
  conversionServiceMock.cancel.mockClear();
  conversionServiceMock.getQueueStatus.mockClear();
  triageServiceMock.saveProgress.mockClear();
  triageServiceMock.getProgress.mockClear();
  storageStatsServiceMock.createStorageSnapshot.mockClear();
  thumbnailsServiceMock.findById.mockClear();
  storyboardsServiceMock.findByVideoId.mockClear();
  videosSearchServiceMock.list.mockClear();
  creatorsServiceMock.findById.mockClear();
  tagsServiceMock.findById.mockClear();
  studiosServiceMock.findById.mockClear();
});

async function createApp(
  register: (app: ReturnType<typeof Fastify>) => Promise<void>,
) {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await register(app);
  return app;
}

describe("API normalization phase 6 route contracts", () => {
  it("serves canonical and deprecated conversion creation routes with deprecation headers", async () => {
    const {
      conversionRoutes,
      conversionStatusRoutes,
      conversionPresetsRoutes,
      deprecatedConversionLegacyStatusRoutes,
      deprecatedConversionPresetsRoutes,
      videoConversionRoutes,
    } = await import("@/modules/conversion/conversion.routes");

    const app = await createApp(async (instance) => {
      await instance.register(videoConversionRoutes, { prefix: "/videos" });
      await instance.register(conversionRoutes, { prefix: "/conversions" });
      await instance.register(conversionStatusRoutes, { prefix: "/conversions" });
      await instance.register(deprecatedConversionLegacyStatusRoutes, {
        prefix: "/conversion",
      });
      await instance.register(conversionPresetsRoutes, {
        prefix: "/conversions/presets",
      });
      await instance.register(deprecatedConversionPresetsRoutes, {
        prefix: "/presets",
      });
    });

    const canonicalResponse = await app.inject({
      method: "POST",
      url: "/videos/12/conversions",
      payload: { preset: "720p_h264" },
    });
    const canonicalBody = canonicalResponse.json() as {
      success: boolean;
      data: typeof conversionJob;
    };
    expect(canonicalResponse.statusCode).toBe(201);
    expect(canonicalResponse.headers.deprecation).toBeUndefined();
    expect(canonicalBody).toEqual({
      success: true,
      data: conversionJob,
    });

    const deprecatedResponse = await app.inject({
      method: "POST",
      url: "/videos/12/convert",
      payload: { preset: "720p_h264" },
    });
    expect(deprecatedResponse.statusCode).toBe(201);
    expect(deprecatedResponse.headers.deprecation).toBe("true");
    expect(deprecatedResponse.headers.sunset).toBeDefined();
    expect(deprecatedResponse.headers.warning).toContain("Deprecated API route");

    const queueStatusResponse = await app.inject({
      method: "GET",
      url: "/conversion/status",
    });
    const queueStatusBody = queueStatusResponse.json() as {
      success: boolean;
      data: { queueLength: number; activeJobs: number; isProcessing: boolean };
    };
    expect(queueStatusResponse.statusCode).toBe(200);
    expect(queueStatusResponse.headers.deprecation).toBe("true");
    expect(queueStatusBody).toEqual({
      success: true,
      data: {
        queueLength: 5,
        activeJobs: 1,
        isProcessing: true,
      },
    });

    const historyOverviewResponse = await app.inject({
      method: "GET",
      url: "/conversions/history/overview?videoId=12",
    });
    expect(historyOverviewResponse.statusCode).toBe(200);
    expect(historyOverviewResponse.json().data).toEqual({
      total_conversions: 3,
      total_original_size_bytes: 1000,
      total_output_size_bytes: 800,
      total_size_delta_bytes: -200,
      total_saved_bytes: 200,
      total_increased_bytes: 0,
      saved_count: 3,
      increased_count: 0,
      unchanged_count: 0,
      avg_size_change_percent: -20,
      avg_conversion_duration_ms: 2000,
    });

    await app.close();
  });

  it("serves canonical and deprecated triage routes with matching payloads", async () => {
    const { triageRoutes, usersTriageLegacyRoutes } = await import(
      "@/modules/triage/triage.routes"
    );

    const app = await createApp(async (instance) => {
      await instance.register(triageRoutes, { prefix: "/triage" });
      await instance.register(usersTriageLegacyRoutes, { prefix: "/users" });
    });

    const canonicalResponse = await app.inject({
      method: "GET",
      url: "/triage/progress?filterKey=untagged",
    });
    const canonicalBody = canonicalResponse.json() as {
      success: boolean;
      data: {
        filter_key: string;
        last_video_id: number;
        processed_count: number;
        total_count: number;
        updated_at: string;
      };
    };
    expect(canonicalResponse.statusCode).toBe(200);
    expect(canonicalBody).toEqual({
      success: true,
      data: {
        filter_key: "untagged",
        last_video_id: 101,
        processed_count: 10,
        total_count: 50,
        updated_at: "2026-05-29T00:00:00.000Z",
      },
    });

    const legacyResponse = await app.inject({
      method: "GET",
      url: "/users/triage-progress?filterKey=untagged",
    });
    expect(legacyResponse.statusCode).toBe(200);
    expect(legacyResponse.headers.deprecation).toBe("true");
    expect(legacyResponse.json() as typeof canonicalBody).toEqual(canonicalBody);

    await app.close();
  });

  it("serves canonical and deprecated stats snapshot routes", async () => {
    const { statsRoutes, statsLegacySnapshotRoutes } = await import(
      "@/modules/stats/stats.routes"
    );

    const app = await createApp(async (instance) => {
      await instance.register(statsRoutes, { prefix: "/stats" });
      await instance.register(statsLegacySnapshotRoutes, { prefix: "/stats" });
    });

    const canonicalResponse = await app.inject({
      method: "POST",
      url: "/stats/storage-snapshots",
    });
    expect(canonicalResponse.statusCode).toBe(201);
    expect(canonicalResponse.headers.deprecation).toBeUndefined();
    expect(canonicalResponse.json().message).toBe("Storage snapshot created");

    const legacyResponse = await app.inject({
      method: "POST",
      url: "/stats/storage/snapshot",
    });
    expect(legacyResponse.statusCode).toBe(201);
    expect(legacyResponse.headers.deprecation).toBe("true");
    expect(legacyResponse.json().data.id).toBe(1);

    await app.close();
  });

  it("returns canonical asset URLs for thumbnail and storyboard metadata", async () => {
    const { thumbnailsRoutes } = await import(
      "@/modules/thumbnails/thumbnails.routes"
    );
    const { storyboardsRoutes } = await import(
      "@/modules/storyboards/storyboards.routes"
    );

    const app = await createApp(async (instance) => {
      await instance.register(thumbnailsRoutes, { prefix: "/thumbnails" });
      await instance.register(storyboardsRoutes, { prefix: "/videos" });
    });

    const thumbnailResponse = await app.inject({
      method: "GET",
      url: "/thumbnails/42",
    });
    expect(thumbnailResponse.statusCode).toBe(200);
    expect(thumbnailResponse.json().data.asset_url).toBe(
      "/api/thumbnails/42/image",
    );

    const storyboardResponse = await app.inject({
      method: "GET",
      url: "/videos/7/storyboard",
    });
    expect(storyboardResponse.statusCode).toBe(200);
    expect(storyboardResponse.json().data.sprite_url).toBe(
      "/api/videos/7/storyboard.webp",
    );
    expect(storyboardResponse.json().data.vtt_url).toBe(
      "/api/videos/7/thumbnails.vtt",
    );

    await app.close();
  });

  it("keeps creator, tag, and studio video convenience endpoints aligned with the canonical video list contract", async () => {
    const { videosRoutes } = await import("@/modules/videos/videos.routes");
    const { creatorsRoutes } = await import("@/modules/creators/creators.routes");
    const { tagsRoutes } = await import("@/modules/tags/tags.routes");
    const { studiosRoutes } = await import("@/modules/studios/studios.routes");

    const app = await createApp(async (instance) => {
      await instance.register(videosRoutes, { prefix: "/videos" });
      await instance.register(creatorsRoutes, { prefix: "/creators" });
      await instance.register(tagsRoutes, { prefix: "/tags" });
      await instance.register(studiosRoutes, { prefix: "/studios" });
    });

    const canonicalResponse = await app.inject({
      method: "GET",
      url: "/videos?page=2&limit=1&include=creators",
    });
    const creatorResponse = await app.inject({
      method: "GET",
      url: "/creators/5/videos?page=2&limit=1&include=creators",
    });
    const tagResponse = await app.inject({
      method: "GET",
      url: "/tags/6/videos?page=2&limit=1&include=creators",
    });
    const studioResponse = await app.inject({
      method: "GET",
      url: "/studios/7/videos?page=2&limit=1&include=creators",
    });
    const canonicalListBody = canonicalResponse.json() as {
      success: boolean;
      data: typeof canonicalVideoList.data;
      pagination: typeof canonicalVideoList.pagination;
    };

    expect(canonicalResponse.statusCode).toBe(200);
    expect(creatorResponse.json() as typeof canonicalListBody).toEqual(
      canonicalListBody,
    );
    expect(tagResponse.json() as typeof canonicalListBody).toEqual(
      canonicalListBody,
    );
    expect(studioResponse.json() as typeof canonicalListBody).toEqual(
      canonicalListBody,
    );

    const listCalls = videosSearchServiceMock.list.mock.calls as unknown as Array<
      [number, Record<string, unknown>]
    >;

    expect(listCalls[0]?.[1]).toMatchObject({
      page: 2,
      limit: 1,
      include: ["creators"],
    });
    expect(listCalls[1]?.[1]).toMatchObject({
      page: 2,
      limit: 1,
      include: ["creators"],
      creatorIds: [5],
    });
    expect(listCalls[2]?.[1]).toMatchObject({
      page: 2,
      limit: 1,
      include: ["creators"],
      tagIds: [6],
    });
    expect(listCalls[3]?.[1]).toMatchObject({
      page: 2,
      limit: 1,
      include: ["creators"],
      studioIds: [7],
    });

    await app.close();
  });
});
