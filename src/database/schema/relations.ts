import { relations } from 'drizzle-orm';

// Import all tables
import { usersTable, sessionsTable } from './users.schema';
import { watchedDirectoriesTable, scanLogsTable } from './directories.schema';
import { videosTable, videoStatsTable, videoMetadataTable } from './videos.schema';
import {
  creatorsTable,
  videoCreatorsTable,
  tagsTable,
  videoTagsTable,
  studiosTable,
  videoStudiosTable,
  creatorStudiosTable,
  platformsTable,
  creatorPlatformsTable,
  creatorSocialLinksTable,
  studioSocialLinksTable,
} from './organization.schema';
import {
  playlistsTable,
  playlistVideosTable,
  favoritesTable,
  bookmarksTable,
  ratingsTable,
} from './content.schema';
import { thumbnailsTable, storyboardsTable } from './media.schema';
import { conversionJobsTable } from './conversion.schema';
import { triageProgressTable } from './triage.schema';
import {
  taggingRulesTable,
  taggingRuleConditionsTable,
  taggingRuleActionsTable,
  taggingRuleLogTable,
} from './tagging.schema';

// Users relations
export const usersRelations = relations(usersTable, ({ many }) => ({
  sessions: many(sessionsTable),
  playlists: many(playlistsTable),
  favorites: many(favoritesTable),
  bookmarks: many(bookmarksTable),
  videoStats: many(videoStatsTable),
  triageProgress: many(triageProgressTable),
}));

// Sessions relations
export const sessionsRelations = relations(sessionsTable, ({ one }) => ({
  user: one(usersTable, {
    fields: [sessionsTable.userId],
    references: [usersTable.id],
  }),
}));

// Watched directories relations
export const watchedDirectoriesRelations = relations(watchedDirectoriesTable, ({ many }) => ({
  videos: many(videosTable),
  scanLogs: many(scanLogsTable),
}));

// Scan logs relations
export const scanLogsRelations = relations(scanLogsTable, ({ one }) => ({
  directory: one(watchedDirectoriesTable, {
    fields: [scanLogsTable.directoryId],
    references: [watchedDirectoriesTable.id],
  }),
}));

// Videos relations
export const videosRelations = relations(videosTable, ({ one, many }) => ({
  directory: one(watchedDirectoriesTable, {
    fields: [videosTable.directoryId],
    references: [watchedDirectoriesTable.id],
  }),
  thumbnail: one(thumbnailsTable, {
    fields: [videosTable.id],
    references: [thumbnailsTable.videoId],
  }),
  storyboard: one(storyboardsTable, {
    fields: [videosTable.id],
    references: [storyboardsTable.videoId],
  }),
  videoCreators: many(videoCreatorsTable),
  videoTags: many(videoTagsTable),
  videoStudios: many(videoStudiosTable),
  playlistVideos: many(playlistVideosTable),
  favorites: many(favoritesTable),
  bookmarks: many(bookmarksTable),
  ratings: many(ratingsTable),
  videoStats: many(videoStatsTable),
  videoMetadata: many(videoMetadataTable),
  conversionJobs: many(conversionJobsTable),
  taggingRuleLogs: many(taggingRuleLogTable),
}));

// Video stats relations
export const videoStatsRelations = relations(videoStatsTable, ({ one }) => ({
  user: one(usersTable, {
    fields: [videoStatsTable.userId],
    references: [usersTable.id],
  }),
  video: one(videosTable, {
    fields: [videoStatsTable.videoId],
    references: [videosTable.id],
  }),
}));

// Video metadata relations
export const videoMetadataRelations = relations(videoMetadataTable, ({ one }) => ({
  video: one(videosTable, {
    fields: [videoMetadataTable.videoId],
    references: [videosTable.id],
  }),
}));

// Creators relations
export const creatorsRelations = relations(creatorsTable, ({ many }) => ({
  videoCreators: many(videoCreatorsTable),
  creatorStudios: many(creatorStudiosTable),
  creatorPlatforms: many(creatorPlatformsTable),
  creatorSocialLinks: many(creatorSocialLinksTable),
}));

// Video-Creator junction relations
export const videoCreatorsRelations = relations(videoCreatorsTable, ({ one }) => ({
  video: one(videosTable, {
    fields: [videoCreatorsTable.videoId],
    references: [videosTable.id],
  }),
  creator: one(creatorsTable, {
    fields: [videoCreatorsTable.creatorId],
    references: [creatorsTable.id],
  }),
}));

// Tags relations (self-referencing)
export const tagsRelations = relations(tagsTable, ({ one, many }) => ({
  parent: one(tagsTable, {
    fields: [tagsTable.parentId],
    references: [tagsTable.id],
    relationName: 'parentChild',
  }),
  children: many(tagsTable, {
    relationName: 'parentChild',
  }),
  videoTags: many(videoTagsTable),
}));

// Video-Tag junction relations
export const videoTagsRelations = relations(videoTagsTable, ({ one }) => ({
  video: one(videosTable, {
    fields: [videoTagsTable.videoId],
    references: [videosTable.id],
  }),
  tag: one(tagsTable, {
    fields: [videoTagsTable.tagId],
    references: [tagsTable.id],
  }),
}));

// Studios relations
export const studiosRelations = relations(studiosTable, ({ many }) => ({
  videoStudios: many(videoStudiosTable),
  creatorStudios: many(creatorStudiosTable),
  studioSocialLinks: many(studioSocialLinksTable),
}));

// Video-Studio junction relations
export const videoStudiosRelations = relations(videoStudiosTable, ({ one }) => ({
  video: one(videosTable, {
    fields: [videoStudiosTable.videoId],
    references: [videosTable.id],
  }),
  studio: one(studiosTable, {
    fields: [videoStudiosTable.studioId],
    references: [studiosTable.id],
  }),
}));

// Creator-Studio junction relations
export const creatorStudiosRelations = relations(creatorStudiosTable, ({ one }) => ({
  creator: one(creatorsTable, {
    fields: [creatorStudiosTable.creatorId],
    references: [creatorsTable.id],
  }),
  studio: one(studiosTable, {
    fields: [creatorStudiosTable.studioId],
    references: [studiosTable.id],
  }),
}));

// Platforms relations
export const platformsRelations = relations(platformsTable, ({ many }) => ({
  creatorPlatforms: many(creatorPlatformsTable),
}));

// Creator platforms relations
export const creatorPlatformsRelations = relations(creatorPlatformsTable, ({ one }) => ({
  creator: one(creatorsTable, {
    fields: [creatorPlatformsTable.creatorId],
    references: [creatorsTable.id],
  }),
  platform: one(platformsTable, {
    fields: [creatorPlatformsTable.platformId],
    references: [platformsTable.id],
  }),
}));

// Creator social links relations
export const creatorSocialLinksRelations = relations(creatorSocialLinksTable, ({ one }) => ({
  creator: one(creatorsTable, {
    fields: [creatorSocialLinksTable.creatorId],
    references: [creatorsTable.id],
  }),
}));

// Studio social links relations
export const studioSocialLinksRelations = relations(studioSocialLinksTable, ({ one }) => ({
  studio: one(studiosTable, {
    fields: [studioSocialLinksTable.studioId],
    references: [studiosTable.id],
  }),
}));

// Playlists relations
export const playlistsRelations = relations(playlistsTable, ({ one, many }) => ({
  user: one(usersTable, {
    fields: [playlistsTable.userId],
    references: [usersTable.id],
  }),
  playlistVideos: many(playlistVideosTable),
}));

// Playlist-Video junction relations
export const playlistVideosRelations = relations(playlistVideosTable, ({ one }) => ({
  playlist: one(playlistsTable, {
    fields: [playlistVideosTable.playlistId],
    references: [playlistsTable.id],
  }),
  video: one(videosTable, {
    fields: [playlistVideosTable.videoId],
    references: [videosTable.id],
  }),
}));

// Favorites relations
export const favoritesRelations = relations(favoritesTable, ({ one }) => ({
  user: one(usersTable, {
    fields: [favoritesTable.userId],
    references: [usersTable.id],
  }),
  video: one(videosTable, {
    fields: [favoritesTable.videoId],
    references: [videosTable.id],
  }),
}));

// Bookmarks relations
export const bookmarksRelations = relations(bookmarksTable, ({ one }) => ({
  user: one(usersTable, {
    fields: [bookmarksTable.userId],
    references: [usersTable.id],
  }),
  video: one(videosTable, {
    fields: [bookmarksTable.videoId],
    references: [videosTable.id],
  }),
}));

// Ratings relations
export const ratingsRelations = relations(ratingsTable, ({ one }) => ({
  video: one(videosTable, {
    fields: [ratingsTable.videoId],
    references: [videosTable.id],
  }),
}));

// Thumbnails relations
export const thumbnailsRelations = relations(thumbnailsTable, ({ one }) => ({
  video: one(videosTable, {
    fields: [thumbnailsTable.videoId],
    references: [videosTable.id],
  }),
}));

// Storyboards relations
export const storyboardsRelations = relations(storyboardsTable, ({ one }) => ({
  video: one(videosTable, {
    fields: [storyboardsTable.videoId],
    references: [videosTable.id],
  }),
}));

// Conversion jobs relations
export const conversionJobsRelations = relations(conversionJobsTable, ({ one }) => ({
  video: one(videosTable, {
    fields: [conversionJobsTable.videoId],
    references: [videosTable.id],
  }),
}));

// Triage progress relations
export const triageProgressRelations = relations(triageProgressTable, ({ one }) => ({
  user: one(usersTable, {
    fields: [triageProgressTable.userId],
    references: [usersTable.id],
  }),
  lastVideo: one(videosTable, {
    fields: [triageProgressTable.lastVideoId],
    references: [videosTable.id],
  }),
}));

// Tagging rules relations
export const taggingRulesRelations = relations(taggingRulesTable, ({ many }) => ({
  conditions: many(taggingRuleConditionsTable),
  actions: many(taggingRuleActionsTable),
  logs: many(taggingRuleLogTable),
}));

// Tagging rule conditions relations
export const taggingRuleConditionsRelations = relations(taggingRuleConditionsTable, ({ one }) => ({
  rule: one(taggingRulesTable, {
    fields: [taggingRuleConditionsTable.ruleId],
    references: [taggingRulesTable.id],
  }),
}));

// Tagging rule actions relations
export const taggingRuleActionsRelations = relations(taggingRuleActionsTable, ({ one }) => ({
  rule: one(taggingRulesTable, {
    fields: [taggingRuleActionsTable.ruleId],
    references: [taggingRulesTable.id],
  }),
}));

// Tagging rule log relations
export const taggingRuleLogRelations = relations(taggingRuleLogTable, ({ one }) => ({
  rule: one(taggingRulesTable, {
    fields: [taggingRuleLogTable.ruleId],
    references: [taggingRulesTable.id],
  }),
  video: one(videosTable, {
    fields: [taggingRuleLogTable.videoId],
    references: [videosTable.id],
  }),
}));
