import { SQL, or, eq, gte, lte, sql, ilike, inArray } from "drizzle-orm";
import {
  videosTable,
  ratingsTable,
  videoCreatorsTable,
  videoTagsTable,
  videoStudiosTable,
} from "@/database/schema";
import type { ListVideosOptions } from "./videos.types";

/**
 * Build Drizzle WHERE conditions from ListVideosOptions
 * Reusable helper for list(), getNextVideo(), and getTriageQueue()
 */
export function buildVideoFilters(
  _userId: number,
  options: ListVideosOptions,
): {
  conditions: SQL[];
  needsCreatorJoin: boolean;
  needsTagJoin: boolean;
  needsStudioJoin: boolean;
  needsRatingJoin: boolean;
  matchMode: "any" | "all";
} {
  const {
    directory_id,
    search,
    ids,
    include_hidden = false,
    // Resolution filters
    minWidth,
    maxWidth,
    minHeight,
    maxHeight,
    // File size filters
    minFileSize,
    maxFileSize,
    // Duration filters
    minDuration,
    maxDuration,
    // Codec filters
    codec,
    audioCodec,
    // Bitrate filters
    minBitrate,
    maxBitrate,
    // FPS filters
    minFps,
    maxFps,
    // Rating filters
    minRating,
    maxRating,
    // Relationship filters
    creatorIds,
    tagIds,
    studioIds,
    matchMode = "any",
    // Presence flags
    isFavorite: _isFavorite, // Not yet implemented
    hasThumbnail: _hasThumbnail, // Not yet implemented
    isAvailable,
    // Relationship presence filters
    hasTags,
    hasCreator,
    hasStudio,
    hasRating,
  } = options;

  const conditions: SQL[] = [];

  // Determine required JOINs
  const needsRatingJoin = minRating !== undefined || maxRating !== undefined;
  const needsCreatorJoin = !!(creatorIds && creatorIds.length > 0);
  const needsTagJoin = !!(tagIds && tagIds.length > 0);
  const needsStudioJoin = !!(studioIds && studioIds.length > 0);

  // Availability filter
  if (isAvailable !== undefined) {
    conditions.push(eq(videosTable.isAvailable, isAvailable));
  } else if (!include_hidden) {
    conditions.push(eq(videosTable.isAvailable, true));
  }

  // Directory filter
  if (directory_id) {
    conditions.push(eq(videosTable.directoryId, directory_id));
  }

  // IDs filter
  if (ids && ids.length > 0) {
    conditions.push(inArray(videosTable.id, ids));
  }

  // Search filter
  if (search) {
    const searchPattern = `%${search}%`;
    conditions.push(
      or(
        ilike(videosTable.title, searchPattern),
        ilike(videosTable.description, searchPattern),
        ilike(videosTable.fileName, searchPattern),
      )!,
    );
  }

  // Resolution filters
  if (minWidth !== undefined) {
    conditions.push(gte(videosTable.width, minWidth));
  }
  if (maxWidth !== undefined) {
    conditions.push(lte(videosTable.width, maxWidth));
  }
  if (minHeight !== undefined) {
    conditions.push(gte(videosTable.height, minHeight));
  }
  if (maxHeight !== undefined) {
    conditions.push(lte(videosTable.height, maxHeight));
  }

  // File size filters
  if (minFileSize !== undefined) {
    conditions.push(gte(videosTable.fileSizeBytes, minFileSize));
  }
  if (maxFileSize !== undefined) {
    conditions.push(lte(videosTable.fileSizeBytes, maxFileSize));
  }

  // Duration filters
  if (minDuration !== undefined) {
    conditions.push(gte(videosTable.durationSeconds, minDuration));
  }
  if (maxDuration !== undefined) {
    conditions.push(lte(videosTable.durationSeconds, maxDuration));
  }

  // Codec filters (case-insensitive)
  if (codec) {
    conditions.push(sql`LOWER(${videosTable.codec}) = LOWER(${codec})`);
  }
  if (audioCodec) {
    conditions.push(
      sql`LOWER(${videosTable.audioCodec}) = LOWER(${audioCodec})`,
    );
  }

  // Bitrate filters
  if (minBitrate !== undefined) {
    conditions.push(gte(videosTable.bitrate, minBitrate));
  }
  if (maxBitrate !== undefined) {
    conditions.push(lte(videosTable.bitrate, maxBitrate));
  }

  // FPS filters
  if (minFps !== undefined) {
    conditions.push(gte(videosTable.fps, minFps));
  }
  if (maxFps !== undefined) {
    conditions.push(lte(videosTable.fps, maxFps));
  }

  // NOTE: Rating filters will be applied via JOIN subquery in the search service

  // Relationship presence filters (using EXISTS subqueries)
  if (hasTags === true) {
    conditions.push(
      sql`EXISTS (SELECT 1 FROM ${videoTagsTable} WHERE ${videoTagsTable.videoId} = ${videosTable.id})`,
    );
  } else if (hasTags === false) {
    conditions.push(
      sql`NOT EXISTS (SELECT 1 FROM ${videoTagsTable} WHERE ${videoTagsTable.videoId} = ${videosTable.id})`,
    );
  }

  if (hasCreator === true) {
    conditions.push(
      sql`EXISTS (SELECT 1 FROM ${videoCreatorsTable} WHERE ${videoCreatorsTable.videoId} = ${videosTable.id})`,
    );
  } else if (hasCreator === false) {
    conditions.push(
      sql`NOT EXISTS (SELECT 1 FROM ${videoCreatorsTable} WHERE ${videoCreatorsTable.videoId} = ${videosTable.id})`,
    );
  }

  if (hasStudio === true) {
    conditions.push(
      sql`EXISTS (SELECT 1 FROM ${videoStudiosTable} WHERE ${videoStudiosTable.videoId} = ${videosTable.id})`,
    );
  } else if (hasStudio === false) {
    conditions.push(
      sql`NOT EXISTS (SELECT 1 FROM ${videoStudiosTable} WHERE ${videoStudiosTable.videoId} = ${videosTable.id})`,
    );
  }

  if (hasRating === true) {
    conditions.push(
      sql`EXISTS (SELECT 1 FROM ${ratingsTable} WHERE ${ratingsTable.videoId} = ${videosTable.id})`,
    );
  } else if (hasRating === false) {
    conditions.push(
      sql`NOT EXISTS (SELECT 1 FROM ${ratingsTable} WHERE ${ratingsTable.videoId} = ${videosTable.id})`,
    );
  }

  return {
    conditions,
    needsCreatorJoin,
    needsTagJoin,
    needsStudioJoin,
    needsRatingJoin,
    matchMode,
  };
}

/**
 * Get valid sort column for videos table
 */
export function getValidSortColumn(
  sort: string,
): keyof typeof videosTable.$inferSelect {
  const validSortColumns = [
    "createdAt",
    "fileName",
    "durationSeconds",
    "fileSizeBytes",
    "indexedAt",
    "width",
    "height",
    "bitrate",
    "fps",
  ] as const;

  type ValidColumn = (typeof validSortColumns)[number];

  // Map snake_case to camelCase
  const columnMap: Record<string, ValidColumn> = {
    created_at: "createdAt",
    file_name: "fileName",
    duration_seconds: "durationSeconds",
    file_size_bytes: "fileSizeBytes",
    indexed_at: "indexedAt",
    width: "width",
    height: "height",
    bitrate: "bitrate",
    fps: "fps",
  };

  const mappedColumn = columnMap[sort];
  if (mappedColumn && validSortColumns.includes(mappedColumn)) {
    return mappedColumn;
  }

  // Default to createdAt
  return "createdAt";
}
