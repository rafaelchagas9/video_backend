import { readFileSync } from "fs";
import { resolve } from "path";
import { API_PREFIX } from "@/config/constants";
import { env } from "@/config/env";
import { assertDemoAssetPath, resetDemoRuntimeAssets } from "./assets";
import {
  getDemoSqlite,
  initializeDemoDatabase,
  withDemoTransaction,
} from "./client";
import { demoRepository } from "./repository";
import { restoreDemoBaselineSnapshot } from "./baseline";
import { demoContentAnalysisScenarioLabel } from "./scenarios";
import { prepopulateDemoContentAnalysis } from "@/modules/content-analysis/content-analysis.demo.service";

const DEMO_TIMESTAMP = "2026-01-01T00:00:00.000Z";
const DEMO_VIDEO_CATALOG_SIZE = 132;
const DEMO_USER_ID = 1;

type JsonObject = Record<string, any>;
export interface DemoSeedDocument {
  tags: JsonObject[];
  studios: JsonObject[];
  creators: JsonObject[];
  videos: JsonObject[];
}

const DELETE_ORDER = [
  "demo_playlist_videos",
  "demo_collection_entries",
  "demo_enrichment_runs",
  "demo_enrichment_suggestions",
  "demo_creator_favorites",
  "demo_favorites",
  "demo_bookmark_category_assignments",
  "demo_bookmarks",
  "demo_ratings",
  "demo_video_stats",
  "demo_thumbnails",
  "demo_storyboards",
  "demo_video_creators",
  "demo_video_studios",
  "demo_video_tags",
  "demo_creator_studios",
  "demo_creator_aliases",
  "demo_creator_platforms",
  "demo_creator_social_links",
  "demo_creator_gallery",
  "demo_creator_face_embeddings",
  "demo_tag_aliases",
  "demo_studio_aliases",
  "demo_studio_social_links",
  "demo_playlist_videos",
  "demo_playlists",
  "demo_collection_entries",
  "demo_collections",
  "demo_videos",
  "demo_creators",
  "demo_studios",
  "demo_tags",
  "demo_tag_categories",
  "demo_settings",
  "demo_artwork_assets",
  "demo_artwork",
  "demo_resources",
];

function validateDocument(data: unknown): asserts data is DemoSeedDocument {
  if (!data || typeof data !== "object")
    throw new Error("Demo seed must be an object");
  for (const key of ["tags", "studios", "creators", "videos"] as const) {
    if (!Array.isArray((data as DemoSeedDocument)[key])) {
      throw new Error(`Demo seed field ${key} must be an array`);
    }
  }
  for (const [index, video] of (data as DemoSeedDocument).videos.entries()) {
    if (
      video.studioAssignmentStatus !== undefined &&
      video.studioAssignmentStatus !== "confirmed_none"
    ) {
      throw new Error(
        `Demo seed videos[${index}].studioAssignmentStatus must be confirmed_none when present`
      );
    }
    if (
      video.studioAssignmentStatus === "confirmed_none" &&
      (video.studios ?? []).length > 0
    ) {
      throw new Error(
        `Demo seed videos[${index}] cannot confirm no studio while studios are assigned`
      );
    }
  }
}

function validateAssets(data: DemoSeedDocument): void {
  for (const [index, studio] of data.studios.entries()) {
    if (studio.profilePicturePath) {
      assertDemoAssetPath(
        studio.profilePicturePath,
        `studios[${index}].profilePicturePath`
      );
    }
  }
  for (const [index, creator] of data.creators.entries()) {
    for (const [key, value] of [
      ["profilePicturePath", creator.profilePicturePath],
      ["mainPicturePath", creator.mainPicturePath],
      ["faceThumbnailPath", creator.faceThumbnailPath],
    ] as const) {
      if (value) assertDemoAssetPath(value, `creators[${index}].${key}`);
    }
    for (const [galleryIndex, item] of (creator.galleryMedia || []).entries()) {
      assertDemoAssetPath(
        item.filePath,
        `creators[${index}].galleryMedia[${galleryIndex}]`
      );
    }
    for (const [suggestionIndex, item] of (
      creator.enrichmentSuggestions || []
    ).entries()) {
      if (item.previewPath) {
        assertDemoAssetPath(
          item.previewPath,
          `creators[${index}].enrichmentSuggestions[${suggestionIndex}]`
        );
      }
    }
  }
  for (const [index, video] of data.videos.entries()) {
    assertDemoAssetPath(video.filePath, `videos[${index}].filePath`);
    if (video.thumbnail?.filePath) {
      assertDemoAssetPath(
        video.thumbnail.filePath,
        `videos[${index}].thumbnail.filePath`
      );
    }
    if (video.storyboard?.spritePath) {
      assertDemoAssetPath(
        video.storyboard.spritePath,
        `videos[${index}].storyboard.spritePath`
      );
      assertDemoAssetPath(
        video.storyboard.vttPath,
        `videos[${index}].storyboard.vttPath`
      );
    }
  }
}

function expandVideos(videos: JsonObject[]): JsonObject[] {
  const result = videos.map((video) => structuredClone(video));
  if (result.length === 0) return result;
  while (result.length < DEMO_VIDEO_CATALOG_SIZE) {
    const id = result.length + 1;
    const sourceIndex = (id - 1) % videos.length;
    const source = videos[sourceIndex];
    if (!source) break;
    const label = `Demo ${String(id).padStart(3, "0")}`;
    result.push({
      ...structuredClone(source),
      sourceVideoId: sourceIndex + 1,
      fileName: `${label} - ${source.fileName}`,
      fileHash: `${source.fileHash || "demo-video"}-${id}`,
      title: `${source.title || source.fileName} · ${label}`,
    });
  }
  return result;
}

export function importDemoSeedDocument(
  input: DemoSeedDocument,
  options: { reset?: boolean; source?: string } = {}
): void {
  validateDocument(input);
  validateAssets(input);
  initializeDemoDatabase();
  const sqlite = getDemoSqlite();
  const videos = expandVideos(input.videos);

  withDemoTransaction(() => {
    if (options.reset ?? true) {
      for (const table of DELETE_ORDER) sqlite.exec(`DELETE FROM ${table}`);
      sqlite.exec("DELETE FROM demo_bookmark_categories WHERE kind='custom'");
    }

    const insertTag = sqlite.prepare(
      "INSERT INTO demo_tags (id,name,parent_id,category_id,description,color,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)"
    );
    sqlite.run(
      'INSERT INTO demo_tag_categories (id,name,"group",description,created_at,updated_at) VALUES (?,?,?,?,?,?),(?,?,?,?,?,?)',
      [
        1,
        "Genre",
        "Content",
        "Genre and format labels",
        DEMO_TIMESTAMP,
        DEMO_TIMESTAMP,
        2,
        "Theme",
        "Content",
        "Subject and mood labels",
        DEMO_TIMESTAMP,
        DEMO_TIMESTAMP,
      ]
    );
    const tagIds = new Map<string, number>();
    input.tags.forEach((tag, index) => tagIds.set(tag.name, index + 1));
    input.tags.forEach((tag, index) =>
      insertTag.run(
        index + 1,
        tag.name,
        tag.parentName ? (tagIds.get(tag.parentName) ?? null) : null,
        index % 2 === 0 ? 1 : 2,
        tag.description ?? null,
        tag.color ?? null,
        DEMO_TIMESTAMP,
        DEMO_TIMESTAMP
      )
    );
    if (input.tags[0]) {
      sqlite.run(
        "INSERT INTO demo_tag_aliases (id,tag_id,name,note,created_at) VALUES (?,?,?,?,?)",
        [
          1,
          1,
          `${input.tags[0].name} alternative`,
          "Demo alias",
          DEMO_TIMESTAMP,
        ]
      );
    }

    const insertStudio = sqlite.prepare(
      "INSERT INTO demo_studios (id,name,description,profile_picture_path,parent_studio_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)"
    );
    const insertStudioSocial = sqlite.prepare(
      "INSERT INTO demo_studio_social_links (id,studio_id,platform_name,url,created_at) VALUES (?,?,?,?,?)"
    );
    const studioIds = new Map<string, number>();
    input.studios.forEach((studio, index) => {
      const id = index + 1;
      studioIds.set(studio.name, id);
      insertStudio.run(
        id,
        studio.name,
        studio.description ?? null,
        studio.profilePicturePath ?? null,
        index === 1 || index === 2 ? 1 : null,
        DEMO_TIMESTAMP,
        DEMO_TIMESTAMP
      );
      (studio.socialLinks || []).forEach(
        (link: JsonObject, linkIndex: number) =>
          insertStudioSocial.run(
            linkIndex + 1,
            id,
            link.platformName,
            link.url,
            DEMO_TIMESTAMP
          )
      );
    });
    if (input.studios[0]) {
      sqlite.run(
        "INSERT INTO demo_studio_aliases (id,studio_id,name,note,created_at) VALUES (?,?,?,?,?)",
        [1, 1, `${input.studios[0].name} network`, "Demo alias", DEMO_TIMESTAMP]
      );
    }

    const insertCreator = sqlite.prepare(
      "INSERT INTO demo_creators (id,name,description,profile_picture_path,main_picture_path,face_thumbnail_path,extra_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)"
    );
    const insertAlias = sqlite.prepare(
      "INSERT INTO demo_creator_aliases (id,creator_id,name,note,created_at) VALUES (?,?,?,?,?)"
    );
    const insertPlatform = sqlite.prepare(
      "INSERT INTO demo_creator_platforms (id,creator_id,platform_id,platform_name,username,profile_url,is_primary,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)"
    );
    const insertCreatorSocial = sqlite.prepare(
      "INSERT INTO demo_creator_social_links (id,creator_id,platform_name,url,created_at) VALUES (?,?,?,?,?)"
    );
    const insertGallery = sqlite.prepare(
      "INSERT INTO demo_creator_gallery (id,creator_id,label,description,file_path,is_profile_picture,is_main_picture,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)"
    );
    const insertFace = sqlite.prepare(
      "INSERT INTO demo_creator_face_embeddings (id,creator_id,payload_json,thumbnail_path,is_primary) VALUES (?,?,?,?,?)"
    );
    const insertSuggestion = sqlite.prepare(
      "INSERT INTO demo_enrichment_suggestions (id,entity_type,entity_id,type,field_key,value,source,source_url,confidence,face_match_score,cached_preview_path,status,dedup_hash,raw_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
    );
    const creatorIds = new Map<string, number>();
    let suggestionId = 1;
    input.creators.forEach((creator, index) => {
      const id = index + 1;
      creatorIds.set(creator.name, id);
      const known = new Set([
        "name",
        "description",
        "profilePicturePath",
        "mainPicturePath",
        "faceThumbnailPath",
        "aliases",
        "platforms",
        "socialLinks",
        "galleryMedia",
        "faceEmbeddings",
        "enrichmentSuggestions",
      ]);
      const extra = Object.fromEntries(
        Object.entries(creator).filter(([key]) => !known.has(key))
      );
      insertCreator.run(
        id,
        creator.name,
        creator.description ?? null,
        creator.profilePicturePath ?? null,
        creator.mainPicturePath ?? null,
        creator.faceThumbnailPath ?? null,
        JSON.stringify(extra),
        DEMO_TIMESTAMP,
        DEMO_TIMESTAMP
      );
      (creator.aliases || []).forEach((name: string, itemIndex: number) =>
        insertAlias.run(itemIndex + 1, id, name, null, DEMO_TIMESTAMP)
      );
      (creator.platforms || []).forEach((item: JsonObject, itemIndex: number) =>
        insertPlatform.run(
          itemIndex + 1,
          id,
          itemIndex + 1,
          item.platformName,
          item.username,
          item.profileUrl,
          item.isPrimary ? 1 : 0,
          DEMO_TIMESTAMP,
          DEMO_TIMESTAMP
        )
      );
      (creator.socialLinks || []).forEach(
        (item: JsonObject, itemIndex: number) =>
          insertCreatorSocial.run(
            itemIndex + 1,
            id,
            item.platformName,
            item.url,
            DEMO_TIMESTAMP
          )
      );
      const galleryUrlByPath = new Map<string, string>();
      (creator.galleryMedia || []).forEach(
        (item: JsonObject, itemIndex: number) => {
          const galleryId = itemIndex + 1;
          galleryUrlByPath.set(
            item.filePath,
            `${API_PREFIX}/creators/${id}/gallery/${galleryId}/image`
          );
          insertGallery.run(
            galleryId,
            id,
            item.label ?? null,
            item.description ?? null,
            item.filePath,
            item.filePath === creator.profilePicturePath ? 1 : 0,
            item.filePath === creator.mainPicturePath ? 1 : 0,
            DEMO_TIMESTAMP,
            DEMO_TIMESTAMP
          );
        }
      );
      (creator.faceEmbeddings || []).forEach(
        (item: JsonObject, itemIndex: number) =>
          insertFace.run(
            itemIndex + 1,
            id,
            JSON.stringify(item),
            creator.faceThumbnailPath ?? creator.profilePicturePath ?? null,
            (item.isPrimary ?? itemIndex === 0) ? 1 : 0
          )
      );
      for (const suggestion of creator.enrichmentSuggestions || []) {
        insertSuggestion.run(
          suggestionId,
          "creator",
          id,
          suggestion.type,
          suggestion.fieldKey ?? null,
          String(suggestion.value),
          suggestion.source,
          suggestion.sourceUrl ?? null,
          suggestion.confidence ?? null,
          suggestion.faceMatchScore ?? null,
          suggestion.previewPath
            ? (galleryUrlByPath.get(suggestion.previewPath) ?? null)
            : null,
          "pending",
          `demo-${id}-${suggestion.type}-${suggestionId}`,
          suggestion.raw ? JSON.stringify(suggestion.raw) : null,
          DEMO_TIMESTAMP,
          DEMO_TIMESTAMP
        );
        suggestionId += 1;
      }
    });

    const insertVideo = sqlite.prepare(
      "INSERT INTO demo_videos (id,source_video_id,file_path,file_name,directory_id,file_size_bytes,file_hash,duration_seconds,width,height,codec,bitrate,fps,audio_codec,title,description,themes,is_available,last_verified_at,studio_absence_confirmed_at,indexed_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
    );
    const insertVideoCreator = sqlite.prepare(
      "INSERT OR IGNORE INTO demo_video_creators (video_id,creator_id) VALUES (?,?)"
    );
    const insertVideoStudio = sqlite.prepare(
      "INSERT OR IGNORE INTO demo_video_studios (video_id,studio_id) VALUES (?,?)"
    );
    const insertVideoTag = sqlite.prepare(
      "INSERT OR IGNORE INTO demo_video_tags (video_id,tag_id) VALUES (?,?)"
    );
    const insertCreatorStudio = sqlite.prepare(
      "INSERT OR IGNORE INTO demo_creator_studios (creator_id,studio_id) VALUES (?,?)"
    );
    const insertThumbnail = sqlite.prepare(
      "INSERT INTO demo_thumbnails (video_id,file_path,file_size_bytes,timestamp_seconds,width,height,generated_at) VALUES (?,?,?,?,?,?,?)"
    );
    const insertStoryboard = sqlite.prepare(
      "INSERT INTO demo_storyboards (video_id,sprite_path,vtt_path,tile_width,tile_height,tile_count,interval_seconds,sprite_size_bytes,generated_at) VALUES (?,?,?,?,?,?,?,?,?)"
    );
    const insertRating = sqlite.prepare(
      "INSERT INTO demo_ratings (id,video_id,rating,comment,rated_at) VALUES (?,?,?,?,?)"
    );
    const insertBookmark = sqlite.prepare(
      "INSERT INTO demo_bookmarks (id,video_id,user_id,timestamp_seconds,name,description,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)"
    );
    const insertStats = sqlite.prepare(
      "INSERT INTO demo_video_stats (user_id,video_id,play_count,total_watch_seconds,session_watch_seconds,session_play_counted,last_position_seconds,last_played_at,last_watch_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
    );

    videos.forEach((video, index) => {
      const id = index + 1;
      const sourceVideoId =
        video.sourceVideoId ?? (id <= input.videos.length ? id : null);
      const analysisScenarioLabel =
        id <= 5 ? demoContentAnalysisScenarioLabel(sourceVideoId) : null;
      const title = video.title ?? video.fileName;
      insertVideo.run(
        id,
        sourceVideoId,
        video.filePath,
        video.fileName,
        1,
        video.fileSizeBytes,
        video.fileHash ?? null,
        video.durationSeconds ?? null,
        video.width ?? null,
        video.height ?? null,
        video.codec ?? null,
        video.bitrate ?? null,
        video.fps ?? null,
        video.audioCodec ?? null,
        analysisScenarioLabel
          ? `${title} · Demo: ${analysisScenarioLabel}`
          : (video.title ?? null),
        video.description ?? null,
        video.themes ?? null,
        1,
        null,
        video.studioAssignmentStatus === "confirmed_none"
          ? DEMO_TIMESTAMP
          : null,
        DEMO_TIMESTAMP,
        DEMO_TIMESTAMP,
        DEMO_TIMESTAMP
      );
      for (const name of video.creators || []) {
        const relationId = creatorIds.get(name);
        if (relationId) insertVideoCreator.run(id, relationId);
      }
      for (const name of video.studios || []) {
        const relationId = studioIds.get(name);
        if (relationId) insertVideoStudio.run(id, relationId);
      }
      for (const creatorName of video.creators || []) {
        const creatorId = creatorIds.get(creatorName);
        if (!creatorId) continue;
        for (const studioName of video.studios || []) {
          const studioId = studioIds.get(studioName);
          if (studioId) insertCreatorStudio.run(creatorId, studioId);
        }
      }
      for (const name of video.tags || []) {
        const relationId = tagIds.get(name);
        if (relationId) insertVideoTag.run(id, relationId);
      }
      if (video.thumbnail) {
        insertThumbnail.run(
          id,
          video.thumbnail.filePath,
          1024,
          video.thumbnail.timestampSeconds,
          video.thumbnail.width,
          video.thumbnail.height,
          DEMO_TIMESTAMP
        );
      }
      if (video.storyboard) {
        insertStoryboard.run(
          id,
          video.storyboard.spritePath,
          video.storyboard.vttPath,
          video.storyboard.tileWidth,
          video.storyboard.tileHeight,
          video.storyboard.tileCount,
          video.storyboard.intervalSeconds,
          2048,
          DEMO_TIMESTAMP
        );
      }
      (video.ratings || []).forEach((item: JsonObject, itemIndex: number) =>
        insertRating.run(
          id * 1000 + itemIndex + 1,
          id,
          item.rating,
          item.comment ?? null,
          item.ratedAt ?? DEMO_TIMESTAMP
        )
      );
      (video.bookmarks || []).forEach((item: JsonObject, itemIndex: number) =>
        insertBookmark.run(
          id * 1000 + itemIndex + 1,
          id,
          DEMO_USER_ID,
          item.timestampSeconds,
          item.name,
          item.description ?? null,
          DEMO_TIMESTAMP,
          DEMO_TIMESTAMP
        )
      );
      const stats = video.stats || {};
      const activityAt =
        (stats.playCount ?? 0) > 0
          ? new Date(
              Date.parse(DEMO_TIMESTAMP) + id * 60 * 60 * 1000
            ).toISOString()
          : null;
      insertStats.run(
        DEMO_USER_ID,
        id,
        stats.playCount ?? 0,
        stats.totalWatchSeconds ?? 0,
        0,
        0,
        stats.lastPositionSeconds ?? 0,
        stats.lastPlayedAt ?? activityAt,
        stats.lastWatchAt ?? activityAt,
        DEMO_TIMESTAMP,
        DEMO_TIMESTAMP
      );
    });

    seedMutableLibrary(
      sqlite,
      new Set(videos.map((_video, index) => index + 1))
    );
    prepopulateDemoContentAnalysis();
    sqlite.exec(
      "INSERT OR REPLACE INTO sqlite_sequence (name,seq) VALUES ('demo_bookmarks',1000000)"
    );
    sqlite.exec(
      "INSERT OR REPLACE INTO sqlite_sequence (name,seq) VALUES ('demo_ratings',1000000)"
    );
    sqlite
      .prepare(
        "INSERT OR REPLACE INTO demo_meta (key,value,updated_at) VALUES ('seed',?,?)"
      )
      .run(
        JSON.stringify({ version: 1, source: options.source ?? "unknown" }),
        DEMO_TIMESTAMP
      );
    sqlite
      .prepare(
        "INSERT OR REPLACE INTO demo_meta (key,value,updated_at) VALUES ('base_video_count',?,?)"
      )
      .run(String(input.videos.length), DEMO_TIMESTAMP);
  });
}

function seedMutableLibrary(
  sqlite: ReturnType<typeof getDemoSqlite>,
  videoIds: Set<number>
): void {
  const favorite = sqlite.prepare(
    "INSERT OR IGNORE INTO demo_favorites (user_id,video_id,added_at) VALUES (?,?,?)"
  );
  for (const id of [5, 7, 8])
    if (videoIds.has(id)) favorite.run(DEMO_USER_ID, id, DEMO_TIMESTAMP);

  const playlist = sqlite.prepare(
    "INSERT INTO demo_playlists (id,user_id,name,description,artwork_source_video_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)"
  );
  const playlistVideo = sqlite.prepare(
    "INSERT INTO demo_playlist_videos (playlist_id,video_id,position,added_at) VALUES (?,?,?,?)"
  );
  const seeds = [
    [
      1,
      "Cinematic Showcase",
      "Demo playlist with action-heavy game cinematics.",
      [1, 3, 4],
    ],
    [
      2,
      "Trailer Queue",
      "Demo playlist with upcoming movie and animation trailers.",
      [5, 6, 7, 8],
    ],
  ] as const;
  for (const [id, name, description, ids] of seeds) {
    playlist.run(
      id,
      DEMO_USER_ID,
      name,
      description,
      ids.find((videoId) => videoIds.has(videoId)) ?? null,
      DEMO_TIMESTAMP,
      DEMO_TIMESTAMP
    );
    ids
      .filter((videoId) => videoIds.has(videoId))
      .forEach((videoId, index) =>
        playlistVideo.run(id, videoId, index, DEMO_TIMESTAMP)
      );
  }

  const collection = sqlite.prepare(
    "INSERT INTO demo_collections (id,title,kind,description,release_year,external_ids_json,artwork_source_video_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)"
  );
  const entry = sqlite.prepare(
    "INSERT INTO demo_collection_entries (id,collection_id,video_id,entry_kind,sequence_number,season_number,episode_number,episode_part,absolute_number,display_title_override,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)"
  );
  collection.run(
    1,
    "Overwatch Animated Shorts",
    "anthology",
    "Demo anthology of animated shorts.",
    null,
    null,
    videoIds.has(2) ? 2 : null,
    DEMO_TIMESTAMP,
    DEMO_TIMESTAMP
  );
  collection.run(
    2,
    "Demo Trailer Collection",
    "movie_series",
    "Demo collection of related trailer content.",
    null,
    null,
    videoIds.has(5) ? 5 : null,
    DEMO_TIMESTAMP,
    DEMO_TIMESTAMP
  );
  const entries = [
    [1, 1, 2, "episode", 1, 1, 1],
    [2, 1, 4, "episode", 2, 1, 2],
    [3, 2, 5, "movie", 1, null, null],
    [4, 2, 7, "movie", 2, null, null],
    [5, 2, 8, "special", 3, null, null],
  ] as const;
  for (const [
    id,
    collectionId,
    videoId,
    kind,
    sequence,
    season,
    episode,
  ] of entries) {
    if (videoIds.has(videoId)) {
      entry.run(
        id,
        collectionId,
        videoId,
        kind,
        sequence,
        season,
        episode,
        null,
        sequence,
        null,
        DEMO_TIMESTAMP,
        DEMO_TIMESTAMP
      );
    }
  }
}

export function importDemoJsonFile(
  path = resolve(process.cwd(), env.DEMO_ASSETS_DIR, "demo_mode.json"),
  options: { reset?: boolean; ifEmpty?: boolean } = {}
): boolean {
  initializeDemoDatabase();
  if (options.ifEmpty) {
    const count =
      getDemoSqlite()
        .query<
          { count: number },
          []
        >("SELECT count(*) AS count FROM demo_videos")
        .get()?.count ?? 0;
    if (count > 0) return false;
  }
  const data: unknown = JSON.parse(readFileSync(path, "utf8"));
  validateDocument(data);
  importDemoSeedDocument(data, { reset: options.reset, source: path });
  return true;
}

export function hasDemoSeed(): boolean {
  initializeDemoDatabase();
  return (
    (getDemoSqlite()
      .query<{ count: number }, []>("SELECT count(*) AS count FROM demo_videos")
      .get()?.count ?? 0) > 0
  );
}

export function ensureDemoEntityPageData(): void {
  initializeDemoDatabase();
  getDemoSqlite().exec(`
    INSERT INTO demo_bookmark_categories
      (key, name, kind, user_id, created_at, updated_at)
    VALUES
      ('BUTTOCKS_EXPOSED', 'BUTTOCKS_EXPOSED', 'system', NULL, '${DEMO_TIMESTAMP}', '${DEMO_TIMESTAMP}'),
      ('FEMALE_BREAST_EXPOSED', 'FEMALE_BREAST_EXPOSED', 'system', NULL, '${DEMO_TIMESTAMP}', '${DEMO_TIMESTAMP}'),
      ('FEMALE_GENITALIA_EXPOSED', 'FEMALE_GENITALIA_EXPOSED', 'system', NULL, '${DEMO_TIMESTAMP}', '${DEMO_TIMESTAMP}'),
      ('MALE_BREAST_EXPOSED', 'MALE_BREAST_EXPOSED', 'system', NULL, '${DEMO_TIMESTAMP}', '${DEMO_TIMESTAMP}'),
      ('ANUS_EXPOSED', 'ANUS_EXPOSED', 'system', NULL, '${DEMO_TIMESTAMP}', '${DEMO_TIMESTAMP}'),
      ('FEET_EXPOSED', 'FEET_EXPOSED', 'system', NULL, '${DEMO_TIMESTAMP}', '${DEMO_TIMESTAMP}'),
      ('ARMPITS_EXPOSED', 'ARMPITS_EXPOSED', 'system', NULL, '${DEMO_TIMESTAMP}', '${DEMO_TIMESTAMP}'),
      ('BELLY_EXPOSED', 'BELLY_EXPOSED', 'system', NULL, '${DEMO_TIMESTAMP}', '${DEMO_TIMESTAMP}'),
      ('MALE_GENITALIA_EXPOSED', 'MALE_GENITALIA_EXPOSED', 'system', NULL, '${DEMO_TIMESTAMP}', '${DEMO_TIMESTAMP}'),
      ('ANUS_COVERED', 'ANUS_COVERED', 'system', NULL, '${DEMO_TIMESTAMP}', '${DEMO_TIMESTAMP}'),
      ('FEMALE_GENITALIA_COVERED', 'FEMALE_GENITALIA_COVERED', 'system', NULL, '${DEMO_TIMESTAMP}', '${DEMO_TIMESTAMP}')
    ON CONFLICT (key) WHERE kind = 'system'
    DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at;

    INSERT OR IGNORE INTO demo_tag_categories
      (id, name, "group", description, created_at, updated_at)
    VALUES
      (1, 'Genre', 'Content', 'Genre and format labels', '${DEMO_TIMESTAMP}', '${DEMO_TIMESTAMP}'),
      (2, 'Theme', 'Content', 'Subject and mood labels', '${DEMO_TIMESTAMP}', '${DEMO_TIMESTAMP}');

    UPDATE demo_tags
    SET category_id = CASE WHEN id % 2 = 1 THEN 1 ELSE 2 END
    WHERE category_id IS NULL;

    INSERT OR IGNORE INTO demo_tag_aliases
      (id, tag_id, name, note, created_at)
    SELECT 1, id, name || ' alternative', 'Demo alias', '${DEMO_TIMESTAMP}'
    FROM demo_tags
    WHERE id = 1;

    UPDATE demo_studios
    SET parent_studio_id = 1
    WHERE id IN (2, 3)
      AND EXISTS (SELECT 1 FROM demo_studios parent WHERE parent.id = 1)
      AND parent_studio_id IS NULL;

    INSERT OR IGNORE INTO demo_studio_aliases
      (id, studio_id, name, note, created_at)
    SELECT 1, id, name || ' network', 'Demo alias', '${DEMO_TIMESTAMP}'
    FROM demo_studios
    WHERE id = 1;

    UPDATE demo_playlists
    SET artwork_source_video_id = (
      SELECT pv.video_id
      FROM demo_playlist_videos pv
      WHERE pv.playlist_id = demo_playlists.id
      ORDER BY pv.position, pv.added_at
      LIMIT 1
    )
    WHERE artwork_source_video_id IS NULL;

    UPDATE demo_collections
    SET artwork_source_video_id = (
      SELECT e.video_id
      FROM demo_collection_entries e
      WHERE e.collection_id = demo_collections.id
      ORDER BY
        CASE WHEN e.sequence_number IS NULL THEN 1 ELSE 0 END,
        e.sequence_number,
        e.season_number,
        e.episode_number,
        e.episode_part,
        e.absolute_number,
        e.created_at
      LIMIT 1
    )
    WHERE artwork_source_video_id IS NULL;

    UPDATE demo_video_stats
    SET
      last_played_at = COALESCE(
        last_played_at,
        strftime('%Y-%m-%dT%H:%M:%fZ', '2026-01-01 00:00:00', '+' || video_id || ' hours')
      ),
      last_watch_at = COALESCE(
        last_watch_at,
        strftime('%Y-%m-%dT%H:%M:%fZ', '2026-01-01 00:00:00', '+' || video_id || ' hours')
      )
    WHERE play_count > 0;
  `);
}

export function resetDemoRuntimeState(): void {
  restoreDemoBaselineSnapshot();
  ensureDemoEntityPageData();
  resetDemoRuntimeAssets();
}

export function exportDemoSeedDocument(): DemoSeedDocument {
  initializeDemoDatabase();
  const sqlite = getDemoSqlite();
  const tags = demoRepository.getTags();
  const tagName = new Map(tags.map((tag: any) => [tag.id, tag.name]));
  const studios = demoRepository.getStudios({ limit: 10_000 }).data;
  const creators = demoRepository.getCreators({ limit: 10_000 }).data;
  const baseVideoCount = Number(
    sqlite
      .query<
        { value: string },
        []
      >("SELECT value FROM demo_meta WHERE key='base_video_count'")
      .get()?.value ?? 44
  );

  return {
    tags: tags.map((tag: any) => ({
      name: tag.name,
      parentName: tag.parent_id ? (tagName.get(tag.parent_id) ?? null) : null,
      description: tag.description,
      color: tag.color,
    })),
    studios: studios.map((studio: any) => ({
      name: studio.name,
      description: studio.description,
      profilePicturePath: studio.profile_picture_path,
      socialLinks: studio.social_links.map((link: any) => ({
        platformName: link.platform_name,
        url: link.url,
      })),
    })),
    creators: creators.map((creator: any) => ({
      name: creator.name,
      description: creator.description,
      profilePicturePath: creator.profile_picture_path,
      mainPicturePath: creator.main_picture_path,
      faceThumbnailPath: creator.face_thumbnail_path,
      aliases: creator.aliases.map((alias: any) => alias.name),
      platforms: creator.platforms.map((platform: any) => ({
        platformName: platform.platform_name,
        username: platform.username,
        profileUrl: platform.profile_url,
        isPrimary: platform.is_primary,
      })),
      socialLinks: creator.social_links.map((link: any) => ({
        platformName: link.platform_name,
        url: link.url,
      })),
      galleryMedia: creator.gallery_media.map((media: any) => ({
        label: media.label,
        description: media.description,
        filePath: media.file_path,
      })),
      faceEmbeddings: creator.face_embeddings.map((embedding: any) => {
        const {
          id: _id,
          creator_id: _creatorId,
          thumbnailPath: _thumbnailPath,
          is_primary: _isPrimary,
          ...payload
        } = embedding;
        return payload;
      }),
      enrichmentSuggestions: demoRepository
        .getEnrichmentSuggestions({
          entity_type: "creator",
          entity_id: creator.id,
        })
        .map((suggestion: any) => ({
          type: suggestion.type,
          fieldKey: suggestion.field_key,
          value: suggestion.value,
          source: suggestion.source,
          sourceUrl: suggestion.source_url,
          confidence: suggestion.confidence,
          faceMatchScore: suggestion.face_match_score,
          raw: suggestion.raw,
        })),
    })),
    videos: Array.from({ length: baseVideoCount }, (_value, index) => {
      const video = demoRepository.getVideoById(index + 1);
      return {
        filePath: video.file_path,
        fileName: video.file_name,
        fileSizeBytes: video.file_size_bytes,
        fileHash: video.file_hash,
        durationSeconds: video.duration_seconds,
        width: video.width,
        height: video.height,
        codec: video.codec,
        bitrate: video.bitrate,
        fps: video.fps,
        audioCodec: video.audio_codec,
        title: video.title,
        description: video.description,
        themes: video.themes,
        creators: video.creators.map((creator: any) => creator.name),
        studios: video.studios.map((studio: any) => studio.name),
        studioAssignmentStatus:
          video.studio_assignment_status === "confirmed_none"
            ? "confirmed_none"
            : undefined,
        tags: video.tags.map((tag: any) => tag.name),
        thumbnail: video.thumbnail
          ? {
              filePath: video.thumbnail.file_path,
              timestampSeconds: video.thumbnail.timestamp_seconds,
              width: video.thumbnail.width,
              height: video.thumbnail.height,
            }
          : null,
        storyboard: video.storyboard
          ? {
              spritePath: video.storyboard.sprite_path,
              vttPath: video.storyboard.vtt_path,
              tileWidth: video.storyboard.tile_width,
              tileHeight: video.storyboard.tile_height,
              tileCount: video.storyboard.tile_count,
              intervalSeconds: video.storyboard.interval_seconds,
            }
          : null,
        ratings: video.ratings.map((rating: any) => ({
          rating: rating.rating,
          comment: rating.comment,
          ratedAt: rating.rated_at,
        })),
        bookmarks: video.bookmarks.map((bookmark: any) => ({
          timestampSeconds: bookmark.timestamp_seconds,
          name: bookmark.name,
          description: bookmark.description,
        })),
        stats: video.stats,
      };
    }),
  };
}
