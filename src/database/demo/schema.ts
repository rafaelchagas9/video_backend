import {
  index,
  integer,
  foreignKey,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";

const timestamps = {
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
};

export const demoMetaTable = sqliteTable("demo_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const demoTagCategoriesTable = sqliteTable("demo_tag_categories", {
  id: integer("id").primaryKey(),
  name: text("name").notNull().unique(),
  group: text("group"),
  description: text("description"),
  ...timestamps,
});

export const demoTagsTable = sqliteTable(
  "demo_tags",
  {
    id: integer("id").primaryKey(),
    name: text("name").notNull(),
    parentId: integer("parent_id").references(
      (): AnySQLiteColumn => demoTagsTable.id,
      { onDelete: "cascade" }
    ),
    categoryId: integer("category_id"),
    description: text("description"),
    color: text("color"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("demo_tags_name_parent_unique").on(table.name, table.parentId),
    index("demo_tags_parent_idx").on(table.parentId),
    foreignKey({
      columns: [table.categoryId],
      foreignColumns: [demoTagCategoriesTable.id],
      name: "demo_tags_category_id_demo_tag_categories_id_fk",
    }).onDelete("set null"),
  ]
);

export const demoTagAliasesTable = sqliteTable(
  "demo_tag_aliases",
  {
    id: integer("id").primaryKey(),
    tagId: integer("tag_id")
      .notNull()
      .references(() => demoTagsTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    note: text("note"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("demo_tag_aliases_tag_idx").on(table.tagId),
    uniqueIndex("demo_tag_aliases_tag_name_unique").on(table.tagId, table.name),
  ]
);

export const demoStudiosTable = sqliteTable(
  "demo_studios",
  {
    id: integer("id").primaryKey(),
    name: text("name").notNull().unique(),
    description: text("description"),
    profilePicturePath: text("profile_picture_path"),
    parentStudioId: integer("parent_studio_id"),
    ...timestamps,
  },
  (table) => [
    foreignKey({
      columns: [table.parentStudioId],
      foreignColumns: [table.id],
      name: "demo_studios_parent_studio_id_demo_studios_id_fk",
    }).onDelete("set null"),
  ]
);

export const demoStudioAliasesTable = sqliteTable(
  "demo_studio_aliases",
  {
    id: integer("id").primaryKey(),
    studioId: integer("studio_id")
      .notNull()
      .references(() => demoStudiosTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    note: text("note"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("demo_studio_aliases_studio_idx").on(table.studioId),
    uniqueIndex("demo_studio_aliases_studio_name_unique").on(
      table.studioId,
      table.name
    ),
  ]
);

export const demoStudioSocialLinksTable = sqliteTable(
  "demo_studio_social_links",
  {
    id: integer("id").notNull(),
    studioId: integer("studio_id")
      .notNull()
      .references(() => demoStudiosTable.id, { onDelete: "cascade" }),
    platformName: text("platform_name").notNull(),
    url: text("url").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.studioId, table.id] })]
);

export const demoCreatorsTable = sqliteTable("demo_creators", {
  id: integer("id").primaryKey(),
  name: text("name").notNull().unique(),
  description: text("description"),
  profilePicturePath: text("profile_picture_path"),
  mainPicturePath: text("main_picture_path"),
  faceThumbnailPath: text("face_thumbnail_path"),
  extraJson: text("extra_json"),
  ...timestamps,
});

export const demoCreatorAliasesTable = sqliteTable(
  "demo_creator_aliases",
  {
    id: integer("id").notNull(),
    creatorId: integer("creator_id")
      .notNull()
      .references(() => demoCreatorsTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    note: text("note"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.creatorId, table.id] })]
);

export const demoCreatorPlatformsTable = sqliteTable(
  "demo_creator_platforms",
  {
    id: integer("id").notNull(),
    creatorId: integer("creator_id")
      .notNull()
      .references(() => demoCreatorsTable.id, { onDelete: "cascade" }),
    platformId: integer("platform_id").notNull(),
    platformName: text("platform_name").notNull(),
    username: text("username").notNull(),
    profileUrl: text("profile_url").notNull(),
    isPrimary: integer("is_primary", { mode: "boolean" }).notNull(),
    ...timestamps,
  },
  (table) => [primaryKey({ columns: [table.creatorId, table.id] })]
);

export const demoCreatorSocialLinksTable = sqliteTable(
  "demo_creator_social_links",
  {
    id: integer("id").notNull(),
    creatorId: integer("creator_id")
      .notNull()
      .references(() => demoCreatorsTable.id, { onDelete: "cascade" }),
    platformName: text("platform_name").notNull(),
    url: text("url").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.creatorId, table.id] })]
);

export const demoCreatorGalleryTable = sqliteTable(
  "demo_creator_gallery",
  {
    id: integer("id").notNull(),
    creatorId: integer("creator_id")
      .notNull()
      .references(() => demoCreatorsTable.id, { onDelete: "cascade" }),
    label: text("label"),
    description: text("description"),
    filePath: text("file_path").notNull(),
    isProfilePicture: integer("is_profile_picture", {
      mode: "boolean",
    }).notNull(),
    isMainPicture: integer("is_main_picture", { mode: "boolean" }).notNull(),
    ...timestamps,
  },
  (table) => [primaryKey({ columns: [table.creatorId, table.id] })]
);

export const demoCreatorFaceEmbeddingsTable = sqliteTable(
  "demo_creator_face_embeddings",
  {
    id: integer("id").notNull(),
    creatorId: integer("creator_id")
      .notNull()
      .references(() => demoCreatorsTable.id, { onDelete: "cascade" }),
    payloadJson: text("payload_json").notNull(),
    thumbnailPath: text("thumbnail_path"),
    isPrimary: integer("is_primary", { mode: "boolean" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.creatorId, table.id] })]
);

export const demoVideosTable = sqliteTable(
  "demo_videos",
  {
    id: integer("id").primaryKey(),
    sourceVideoId: integer("source_video_id"),
    filePath: text("file_path").notNull(),
    fileName: text("file_name").notNull(),
    directoryId: integer("directory_id").notNull(),
    fileSizeBytes: integer("file_size_bytes").notNull(),
    fileHash: text("file_hash"),
    durationSeconds: real("duration_seconds"),
    width: integer("width"),
    height: integer("height"),
    codec: text("codec"),
    bitrate: integer("bitrate"),
    fps: real("fps"),
    audioCodec: text("audio_codec"),
    title: text("title"),
    description: text("description"),
    themes: text("themes"),
    isAvailable: integer("is_available", { mode: "boolean" }).notNull(),
    lastVerifiedAt: text("last_verified_at"),
    studioAbsenceConfirmedAt: text("studio_absence_confirmed_at"),
    indexedAt: text("indexed_at").notNull(),
    ...timestamps,
  },
  (table) => [index("demo_videos_source_idx").on(table.sourceVideoId)]
);

export const demoVideoCreatorsTable = sqliteTable(
  "demo_video_creators",
  {
    videoId: integer("video_id")
      .notNull()
      .references(() => demoVideosTable.id, { onDelete: "cascade" }),
    creatorId: integer("creator_id")
      .notNull()
      .references(() => demoCreatorsTable.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.videoId, table.creatorId] })]
);
export const demoVideoStudiosTable = sqliteTable(
  "demo_video_studios",
  {
    videoId: integer("video_id")
      .notNull()
      .references(() => demoVideosTable.id, { onDelete: "cascade" }),
    studioId: integer("studio_id")
      .notNull()
      .references(() => demoStudiosTable.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.videoId, table.studioId] })]
);
export const demoVideoTagsTable = sqliteTable(
  "demo_video_tags",
  {
    videoId: integer("video_id")
      .notNull()
      .references(() => demoVideosTable.id, { onDelete: "cascade" }),
    tagId: integer("tag_id")
      .notNull()
      .references(() => demoTagsTable.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.videoId, table.tagId] })]
);

export const demoCreatorStudiosTable = sqliteTable(
  "demo_creator_studios",
  {
    creatorId: integer("creator_id")
      .notNull()
      .references(() => demoCreatorsTable.id, { onDelete: "cascade" }),
    studioId: integer("studio_id")
      .notNull()
      .references(() => demoStudiosTable.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.creatorId, table.studioId] })]
);

export const demoThumbnailsTable = sqliteTable("demo_thumbnails", {
  videoId: integer("video_id")
    .primaryKey()
    .references(() => demoVideosTable.id, { onDelete: "cascade" }),
  filePath: text("file_path").notNull(),
  fileSizeBytes: integer("file_size_bytes").notNull(),
  timestampSeconds: real("timestamp_seconds").notNull(),
  width: integer("width").notNull(),
  height: integer("height").notNull(),
  generatedAt: text("generated_at").notNull(),
});
export const demoStoryboardsTable = sqliteTable("demo_storyboards", {
  videoId: integer("video_id")
    .primaryKey()
    .references(() => demoVideosTable.id, { onDelete: "cascade" }),
  spritePath: text("sprite_path").notNull(),
  vttPath: text("vtt_path").notNull(),
  tileWidth: integer("tile_width").notNull(),
  tileHeight: integer("tile_height").notNull(),
  tileCount: integer("tile_count").notNull(),
  intervalSeconds: real("interval_seconds").notNull(),
  spriteSizeBytes: integer("sprite_size_bytes").notNull(),
  generatedAt: text("generated_at").notNull(),
});

export const demoVideoStatsTable = sqliteTable(
  "demo_video_stats",
  {
    userId: integer("user_id").notNull(),
    videoId: integer("video_id")
      .notNull()
      .references(() => demoVideosTable.id, { onDelete: "cascade" }),
    playCount: integer("play_count").notNull(),
    totalWatchSeconds: real("total_watch_seconds").notNull(),
    sessionWatchSeconds: real("session_watch_seconds").notNull(),
    sessionPlayCounted: integer("session_play_counted", {
      mode: "boolean",
    }).notNull(),
    lastPositionSeconds: real("last_position_seconds"),
    lastPlayedAt: text("last_played_at"),
    lastWatchAt: text("last_watch_at"),
    ...timestamps,
  },
  (table) => [primaryKey({ columns: [table.userId, table.videoId] })]
);

export const demoRatingsTable = sqliteTable("demo_ratings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  videoId: integer("video_id")
    .notNull()
    .references(() => demoVideosTable.id, { onDelete: "cascade" }),
  rating: integer("rating").notNull(),
  comment: text("comment"),
  ratedAt: text("rated_at").notNull(),
});
export const demoBookmarksTable = sqliteTable("demo_bookmarks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  videoId: integer("video_id")
    .notNull()
    .references(() => demoVideosTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull(),
  timestampSeconds: real("timestamp_seconds").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  ...timestamps,
});
export const demoFavoritesTable = sqliteTable(
  "demo_favorites",
  {
    userId: integer("user_id").notNull(),
    videoId: integer("video_id")
      .notNull()
      .references(() => demoVideosTable.id, { onDelete: "cascade" }),
    addedAt: text("added_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.videoId] })]
);
export const demoCreatorFavoritesTable = sqliteTable(
  "demo_creator_favorites",
  {
    userId: integer("user_id").notNull(),
    creatorId: integer("creator_id")
      .notNull()
      .references(() => demoCreatorsTable.id, { onDelete: "cascade" }),
    addedAt: text("added_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.creatorId] })]
);

export const demoPlaylistsTable = sqliteTable("demo_playlists", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  artworkSourceVideoId: integer("artwork_source_video_id").references(
    () => demoVideosTable.id,
    { onDelete: "set null" }
  ),
  ...timestamps,
});
export const demoPlaylistVideosTable = sqliteTable(
  "demo_playlist_videos",
  {
    playlistId: integer("playlist_id")
      .notNull()
      .references(() => demoPlaylistsTable.id, { onDelete: "cascade" }),
    videoId: integer("video_id")
      .notNull()
      .references(() => demoVideosTable.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    addedAt: text("added_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.playlistId, table.videoId] })]
);
export const demoCollectionsTable = sqliteTable("demo_collections", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  kind: text("kind").notNull(),
  description: text("description"),
  releaseYear: integer("release_year"),
  externalIdsJson: text("external_ids_json"),
  artworkSourceVideoId: integer("artwork_source_video_id").references(
    () => demoVideosTable.id,
    { onDelete: "set null" }
  ),
  ...timestamps,
});
export const demoCollectionEntriesTable = sqliteTable(
  "demo_collection_entries",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    collectionId: integer("collection_id")
      .notNull()
      .references(() => demoCollectionsTable.id, { onDelete: "cascade" }),
    videoId: integer("video_id")
      .notNull()
      .references(() => demoVideosTable.id, { onDelete: "cascade" }),
    entryKind: text("entry_kind").notNull(),
    sequenceNumber: integer("sequence_number"),
    seasonNumber: integer("season_number"),
    episodeNumber: integer("episode_number"),
    episodePart: integer("episode_part"),
    absoluteNumber: integer("absolute_number"),
    displayTitleOverride: text("display_title_override"),
    ...timestamps,
  },
  (table) => [uniqueIndex("demo_collection_video_unique").on(table.videoId)]
);

export const demoEnrichmentSuggestionsTable = sqliteTable(
  "demo_enrichment_suggestions",
  {
    id: integer("id").primaryKey(),
    entityType: text("entity_type").notNull(),
    entityId: integer("entity_id").notNull(),
    type: text("type").notNull(),
    fieldKey: text("field_key"),
    value: text("value").notNull(),
    source: text("source").notNull(),
    sourceUrl: text("source_url"),
    confidence: real("confidence"),
    faceMatchScore: real("face_match_score"),
    cachedPreviewPath: text("cached_preview_path"),
    status: text("status").notNull(),
    dedupHash: text("dedup_hash").notNull().unique(),
    rawJson: text("raw_json"),
    ...timestamps,
  }
);
export const demoEnrichmentRunsTable = sqliteTable("demo_enrichment_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  entityType: text("entity_type").notNull(),
  entityId: integer("entity_id").notNull(),
  status: text("status").notNull(),
  sourcesUsedJson: text("sources_used_json").notNull(),
  suggestionCount: integer("suggestion_count").notNull(),
  errorsJson: text("errors_json"),
  startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at"),
});
export const demoSettingsTable = sqliteTable("demo_settings", {
  key: text("key").primaryKey(),
  valueJson: text("value_json").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const demoArtworkTable = sqliteTable("demo_artwork", {
  videoId: integer("video_id")
    .primaryKey()
    .references(() => demoVideosTable.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  status: text("status").notNull(),
  paletteJson: text("palette_json"),
  generatedAt: text("generated_at"),
});

export const demoArtworkAssetsTable = sqliteTable(
  "demo_artwork_assets",
  {
    id: integer("id").primaryKey(),
    videoId: integer("video_id")
      .notNull()
      .references(() => demoVideosTable.id, { onDelete: "cascade" }),
    variant: text("variant").notNull(),
    contentHash: text("content_hash").notNull(),
    filePath: text("file_path").notNull(),
    fileSizeBytes: integer("file_size_bytes").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    sourceTimestampSeconds: real("source_timestamp_seconds"),
    cropJson: text("crop_json"),
    focalPointJson: text("focal_point_json"),
    safeAreaJson: text("safe_area_json"),
    bottomLuma: real("bottom_luma"),
    thumbhash: text("thumbhash"),
    effectsJson: text("effects_json").notNull(),
    generatedAt: text("generated_at").notNull(),
  },
  (table) => [
    uniqueIndex("demo_artwork_video_variant_unique").on(
      table.videoId,
      table.variant
    ),
  ]
);

/** Low-volume state for feature simulations that do not justify a dedicated table. */
export const demoResourcesTable = sqliteTable(
  "demo_resources",
  {
    kind: text("kind").notNull(),
    id: text("id").notNull(),
    payloadJson: text("payload_json").notNull(),
    ...timestamps,
  },
  (table) => [primaryKey({ columns: [table.kind, table.id] })]
);
