import { pgTable, serial, text, integer, boolean, timestamp, index, primaryKey, unique } from 'drizzle-orm/pg-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { videosTable } from './videos.schema';

// Creators table
export const creatorsTable = pgTable('creators', {
  id: serial('id').primaryKey(),
  name: text('name').notNull().unique(),
  description: text('description'),
  profilePicturePath: text('profile_picture_path'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// Video-Creator relationship (many-to-many)
export const videoCreatorsTable = pgTable('video_creators', {
  videoId: integer('video_id').notNull().references(() => videosTable.id, { onDelete: 'cascade' }),
  creatorId: integer('creator_id').notNull().references(() => creatorsTable.id, { onDelete: 'cascade' }),
}, (table) => ({
  pk: primaryKey({ columns: [table.videoId, table.creatorId] }),
  videoIdx: index('idx_video_creators_video').on(table.videoId),
  creatorIdx: index('idx_video_creators_creator').on(table.creatorId),
}));

// Hierarchical tags (self-referencing for parent/child)
export const tagsTable = pgTable('tags', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  parentId: integer('parent_id').references((): AnyPgColumn => tagsTable.id, { onDelete: 'cascade' }),
  description: text('description'),
  color: text('color'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  parentIdx: index('idx_tags_parent').on(table.parentId),
  uniqueNameParent: unique('unique_name_parent').on(table.name, table.parentId),
}));

// Video-Tag relationship (many-to-many)
export const videoTagsTable = pgTable('video_tags', {
  videoId: integer('video_id').notNull().references(() => videosTable.id, { onDelete: 'cascade' }),
  tagId: integer('tag_id').notNull().references(() => tagsTable.id, { onDelete: 'cascade' }),
}, (table) => ({
  pk: primaryKey({ columns: [table.videoId, table.tagId] }),
  videoIdx: index('idx_video_tags_video').on(table.videoId),
  tagIdx: index('idx_video_tags_tag').on(table.tagId),
}));

// Studios table (organizations, networks, production companies)
export const studiosTable = pgTable('studios', {
  id: serial('id').primaryKey(),
  name: text('name').notNull().unique(),
  description: text('description'),
  profilePicturePath: text('profile_picture_path'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// Video-Studio relationship (many-to-many)
export const videoStudiosTable = pgTable('video_studios', {
  videoId: integer('video_id').notNull().references(() => videosTable.id, { onDelete: 'cascade' }),
  studioId: integer('studio_id').notNull().references(() => studiosTable.id, { onDelete: 'cascade' }),
}, (table) => ({
  pk: primaryKey({ columns: [table.videoId, table.studioId] }),
  videoIdx: index('idx_video_studios_video').on(table.videoId),
  studioIdx: index('idx_video_studios_studio').on(table.studioId),
}));

// Creator-Studio relationship (many-to-many)
export const creatorStudiosTable = pgTable('creator_studios', {
  creatorId: integer('creator_id').notNull().references(() => creatorsTable.id, { onDelete: 'cascade' }),
  studioId: integer('studio_id').notNull().references(() => studiosTable.id, { onDelete: 'cascade' }),
  addedAt: timestamp('added_at').defaultNow().notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.creatorId, table.studioId] }),
  creatorIdx: index('idx_creator_studios_creator').on(table.creatorId),
  studioIdx: index('idx_creator_studios_studio').on(table.studioId),
}));

// Platforms reference table (Patreon, OnlyFans, etc.)
export const platformsTable = pgTable('platforms', {
  id: serial('id').primaryKey(),
  name: text('name').notNull().unique(),
  baseUrl: text('base_url'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// Creator platform profiles (for fingerprinting and auto-scraping)
export const creatorPlatformsTable = pgTable('creator_platforms', {
  id: serial('id').primaryKey(),
  creatorId: integer('creator_id').notNull().references(() => creatorsTable.id, { onDelete: 'cascade' }),
  platformId: integer('platform_id').notNull().references(() => platformsTable.id, { onDelete: 'cascade' }),
  username: text('username').notNull(),
  profileUrl: text('profile_url').notNull(),
  isPrimary: boolean('is_primary').default(false).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  creatorIdx: index('idx_creator_platforms_creator').on(table.creatorId),
  platformIdx: index('idx_creator_platforms_platform').on(table.platformId),
  usernameIdx: index('idx_creator_platforms_username').on(table.username),
  uniqueCreatorPlatform: unique('unique_creator_platform').on(table.creatorId, table.platformId),
}));

// Creator social media links
export const creatorSocialLinksTable = pgTable('creator_social_links', {
  id: serial('id').primaryKey(),
  creatorId: integer('creator_id').notNull().references(() => creatorsTable.id, { onDelete: 'cascade' }),
  platformName: text('platform_name').notNull(),
  url: text('url').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  creatorIdx: index('idx_creator_social_links_creator').on(table.creatorId),
}));

// Studio social media links
export const studioSocialLinksTable = pgTable('studio_social_links', {
  id: serial('id').primaryKey(),
  studioId: integer('studio_id').notNull().references(() => studiosTable.id, { onDelete: 'cascade' }),
  platformName: text('platform_name').notNull(),
  url: text('url').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  studioIdx: index('idx_studio_social_links_studio').on(table.studioId),
}));

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
export type StudioSocialLink = typeof studioSocialLinksTable.$inferSelect;
export type NewStudioSocialLink = typeof studioSocialLinksTable.$inferInsert;
