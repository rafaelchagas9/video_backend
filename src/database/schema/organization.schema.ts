import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  index,
  primaryKey,
  unique,
} from "drizzle-orm/pg-core";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { videosTable } from "./videos.schema";

// Creators table
export const creatorsTable = pgTable("creators", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  description: text("description"),
  profilePicturePath: text("profile_picture_path"),
  mainPicturePath: text("main_picture_path"),
  faceThumbnailPath: text("face_thumbnail_path"),
  // Rich external metadata (nullable; filled by enrichment, confirmed by the user).
  // Stored as free text rather than pg enums because metadata sources disagree
  // (StashDB returns enums, ThePornDB returns free strings) — validated in Zod.
  gender: text("gender"),
  birthDate: text("birth_date"),
  deathDate: text("death_date"),
  ethnicity: text("ethnicity"),
  country: text("country"),
  birthplace: text("birthplace"),
  eyeColor: text("eye_color"),
  hairColor: text("hair_color"),
  heightCm: integer("height_cm"),
  cupSize: text("cup_size"),
  bandSize: integer("band_size"),
  waistSize: integer("waist_size"),
  hipSize: integer("hip_size"),
  breastType: text("breast_type"),
  careerStartYear: integer("career_start_year"),
  careerEndYear: integer("career_end_year"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Body modifications (tattoos / piercings) discovered from metadata sources
export const creatorBodyModificationsTable = pgTable(
  "creator_body_modifications",
  {
    id: serial("id").primaryKey(),
    creatorId: integer("creator_id")
      .notNull()
      .references(() => creatorsTable.id, { onDelete: "cascade" }),
    type: text("type").notNull(), // "tattoo" | "piercing"
    location: text("location"),
    description: text("description"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    creatorIdx: index("idx_creator_body_modifications_creator").on(
      table.creatorId,
    ),
  }),
);

// External identity per source (ThePornDB / StashDB) — enables re-fetch, dedup,
// and skip-requery. Unique on (source, external_id).
export const creatorExternalIdsTable = pgTable(
  "creator_external_ids",
  {
    id: serial("id").primaryKey(),
    creatorId: integer("creator_id")
      .notNull()
      .references(() => creatorsTable.id, { onDelete: "cascade" }),
    source: text("source").notNull(), // "theporndb" | "stashdb"
    externalId: text("external_id").notNull(),
    externalUrl: text("external_url"),
    lastSyncedAt: timestamp("last_synced_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    creatorIdx: index("idx_creator_external_ids_creator").on(table.creatorId),
    uniqueSourceExternal: unique("unique_creator_external_id").on(
      table.source,
      table.externalId,
    ),
  }),
);

// Merge audit log. fromCreatorId/intoCreatorId are plain integers (no FK) so the
// audit row survives the hard-delete of the merged-away creator; the full old
// record is preserved in `snapshot` for losslessness.
export const creatorMergesTable = pgTable(
  "creator_merges",
  {
    id: serial("id").primaryKey(),
    fromCreatorId: integer("from_creator_id").notNull(),
    intoCreatorId: integer("into_creator_id").notNull(),
    fromName: text("from_name"),
    snapshot: jsonb("snapshot"),
    reason: text("reason"),
    mergedAt: timestamp("merged_at").defaultNow().notNull(),
  },
  (table) => ({
    intoIdx: index("idx_creator_merges_into").on(table.intoCreatorId),
  }),
);

// Video-Creator relationship (many-to-many)
export const videoCreatorsTable = pgTable(
  "video_creators",
  {
    videoId: integer("video_id")
      .notNull()
      .references(() => videosTable.id, { onDelete: "cascade" }),
    creatorId: integer("creator_id")
      .notNull()
      .references(() => creatorsTable.id, { onDelete: "cascade" }),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.videoId, table.creatorId] }),
    videoIdx: index("idx_video_creators_video").on(table.videoId),
    creatorIdx: index("idx_video_creators_creator").on(table.creatorId),
  }),
);

// Hierarchical tags (self-referencing for parent/child)
export const tagsTable = pgTable(
  "tags",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    parentId: integer("parent_id").references((): AnyPgColumn => tagsTable.id, {
      onDelete: "cascade",
    }),
    description: text("description"),
    color: text("color"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    parentIdx: index("idx_tags_parent").on(table.parentId),
    uniqueNameParent: unique("unique_name_parent").on(
      table.name,
      table.parentId,
    ),
  }),
);

// Video-Tag relationship (many-to-many)
export const videoTagsTable = pgTable(
  "video_tags",
  {
    videoId: integer("video_id")
      .notNull()
      .references(() => videosTable.id, { onDelete: "cascade" }),
    tagId: integer("tag_id")
      .notNull()
      .references(() => tagsTable.id, { onDelete: "cascade" }),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.videoId, table.tagId] }),
    videoIdx: index("idx_video_tags_video").on(table.videoId),
    tagIdx: index("idx_video_tags_tag").on(table.tagId),
  }),
);

// Studios table (organizations, networks, production companies)
export const studiosTable = pgTable("studios", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  description: text("description"),
  profilePicturePath: text("profile_picture_path"),
  // Self-referencing hierarchy: network → studio (set null if parent removed).
  parentStudioId: integer("parent_studio_id").references(
    (): AnyPgColumn => studiosTable.id,
    { onDelete: "set null" },
  ),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Studio aliases (alternate / former names) — mirrors creator_aliases
export const studioAliasesTable = pgTable(
  "studio_aliases",
  {
    id: serial("id").primaryKey(),
    studioId: integer("studio_id")
      .notNull()
      .references(() => studiosTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    note: text("note"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    studioIdx: index("idx_studio_aliases_studio").on(table.studioId),
    nameIdx: index("idx_studio_aliases_name").on(table.name),
    uniqueStudioAlias: unique("unique_studio_alias").on(
      table.studioId,
      table.name,
    ),
  }),
);

// External identity per source for studios — mirrors creator_external_ids
export const studioExternalIdsTable = pgTable(
  "studio_external_ids",
  {
    id: serial("id").primaryKey(),
    studioId: integer("studio_id")
      .notNull()
      .references(() => studiosTable.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    externalId: text("external_id").notNull(),
    externalUrl: text("external_url"),
    lastSyncedAt: timestamp("last_synced_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    studioIdx: index("idx_studio_external_ids_studio").on(table.studioId),
    uniqueSourceExternal: unique("unique_studio_external_id").on(
      table.source,
      table.externalId,
    ),
  }),
);

// Video-Studio relationship (many-to-many)
export const videoStudiosTable = pgTable(
  "video_studios",
  {
    videoId: integer("video_id")
      .notNull()
      .references(() => videosTable.id, { onDelete: "cascade" }),
    studioId: integer("studio_id")
      .notNull()
      .references(() => studiosTable.id, { onDelete: "cascade" }),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.videoId, table.studioId] }),
    videoIdx: index("idx_video_studios_video").on(table.videoId),
    studioIdx: index("idx_video_studios_studio").on(table.studioId),
  }),
);

// Creator-Studio relationship (many-to-many)
export const creatorStudiosTable = pgTable(
  "creator_studios",
  {
    creatorId: integer("creator_id")
      .notNull()
      .references(() => creatorsTable.id, { onDelete: "cascade" }),
    studioId: integer("studio_id")
      .notNull()
      .references(() => studiosTable.id, { onDelete: "cascade" }),
    addedAt: timestamp("added_at").defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.creatorId, table.studioId] }),
    creatorIdx: index("idx_creator_studios_creator").on(table.creatorId),
    studioIdx: index("idx_creator_studios_studio").on(table.studioId),
  }),
);

// Platforms reference table (Patreon, OnlyFans, etc.)
export const platformsTable = pgTable("platforms", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  baseUrl: text("base_url"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Creator platform profiles (for fingerprinting and auto-scraping)
export const creatorPlatformsTable = pgTable(
  "creator_platforms",
  {
    id: serial("id").primaryKey(),
    creatorId: integer("creator_id")
      .notNull()
      .references(() => creatorsTable.id, { onDelete: "cascade" }),
    platformId: integer("platform_id")
      .notNull()
      .references(() => platformsTable.id, { onDelete: "cascade" }),
    username: text("username").notNull(),
    profileUrl: text("profile_url").notNull(),
    isPrimary: boolean("is_primary").default(false).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    creatorIdx: index("idx_creator_platforms_creator").on(table.creatorId),
    platformIdx: index("idx_creator_platforms_platform").on(table.platformId),
    usernameIdx: index("idx_creator_platforms_username").on(table.username),
    uniqueCreatorPlatform: unique("unique_creator_platform").on(
      table.creatorId,
      table.platformId,
    ),
  }),
);

// Creator social media links
export const creatorSocialLinksTable = pgTable(
  "creator_social_links",
  {
    id: serial("id").primaryKey(),
    creatorId: integer("creator_id")
      .notNull()
      .references(() => creatorsTable.id, { onDelete: "cascade" }),
    platformName: text("platform_name").notNull(),
    url: text("url").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    creatorIdx: index("idx_creator_social_links_creator").on(table.creatorId),
  }),
);

// Creator aliases (alternate / former names the creator is known by)
export const creatorAliasesTable = pgTable(
  "creator_aliases",
  {
    id: serial("id").primaryKey(),
    creatorId: integer("creator_id")
      .notNull()
      .references(() => creatorsTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    note: text("note"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    creatorIdx: index("idx_creator_aliases_creator").on(table.creatorId),
    nameIdx: index("idx_creator_aliases_name").on(table.name),
    uniqueCreatorAlias: unique("unique_creator_alias").on(
      table.creatorId,
      table.name,
    ),
  }),
);

export const creatorGalleryMediaTable = pgTable(
  "creator_gallery_media",
  {
    id: serial("id").primaryKey(),
    creatorId: integer("creator_id")
      .notNull()
      .references(() => creatorsTable.id, { onDelete: "cascade" }),
    label: text("label"),
    description: text("description"),
    filePath: text("file_path").notNull(),
    isProfilePicture: boolean("is_profile_picture").default(false).notNull(),
    isMainPicture: boolean("is_main_picture").default(false).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    creatorIdx: index("idx_creator_gallery_media_creator").on(table.creatorId),
    profilePictureIdx: index("idx_creator_gallery_media_profile").on(
      table.creatorId,
      table.isProfilePicture,
    ),
    mainPictureIdx: index("idx_creator_gallery_media_main").on(
      table.creatorId,
      table.isMainPicture,
    ),
  }),
);

// Studio social media links
export const studioSocialLinksTable = pgTable(
  "studio_social_links",
  {
    id: serial("id").primaryKey(),
    studioId: integer("studio_id")
      .notNull()
      .references(() => studiosTable.id, { onDelete: "cascade" }),
    platformName: text("platform_name").notNull(),
    url: text("url").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    studioIdx: index("idx_studio_social_links_studio").on(table.studioId),
  }),
);

// Inferred types
export type Creator = typeof creatorsTable.$inferSelect;
export type NewCreator = typeof creatorsTable.$inferInsert;
export type Tag = typeof tagsTable.$inferSelect;
export type NewTag = typeof tagsTable.$inferInsert;
export type Studio = typeof studiosTable.$inferSelect;
export type NewStudio = typeof studiosTable.$inferInsert;
export type Platform = typeof platformsTable.$inferSelect;
export type NewPlatform = typeof platformsTable.$inferInsert;
export type CreatorPlatform = typeof creatorPlatformsTable.$inferSelect;
export type NewCreatorPlatform = typeof creatorPlatformsTable.$inferInsert;
export type CreatorSocialLink = typeof creatorSocialLinksTable.$inferSelect;
export type NewCreatorSocialLink = typeof creatorSocialLinksTable.$inferInsert;
export type CreatorAlias = typeof creatorAliasesTable.$inferSelect;
export type NewCreatorAlias = typeof creatorAliasesTable.$inferInsert;
export type CreatorGalleryMedia = typeof creatorGalleryMediaTable.$inferSelect;
export type NewCreatorGalleryMedia =
  typeof creatorGalleryMediaTable.$inferInsert;
export type StudioSocialLink = typeof studioSocialLinksTable.$inferSelect;
export type NewStudioSocialLink = typeof studioSocialLinksTable.$inferInsert;
export type CreatorBodyModification =
  typeof creatorBodyModificationsTable.$inferSelect;
export type NewCreatorBodyModification =
  typeof creatorBodyModificationsTable.$inferInsert;
export type CreatorExternalId = typeof creatorExternalIdsTable.$inferSelect;
export type NewCreatorExternalId = typeof creatorExternalIdsTable.$inferInsert;
export type CreatorMerge = typeof creatorMergesTable.$inferSelect;
export type NewCreatorMerge = typeof creatorMergesTable.$inferInsert;
export type StudioAlias = typeof studioAliasesTable.$inferSelect;
export type NewStudioAlias = typeof studioAliasesTable.$inferInsert;
export type StudioExternalId = typeof studioExternalIdsTable.$inferSelect;
export type NewStudioExternalId = typeof studioExternalIdsTable.$inferInsert;
