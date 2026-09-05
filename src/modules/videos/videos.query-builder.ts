import { SQL, or, eq, gte, lt, lte, sql, ilike, inArray } from "drizzle-orm";
import {
  videosTable,
  favoritesTable,
  thumbnailsTable,
  ratingsTable,
  videoCreatorsTable,
  videoTagsTable,
  tagsTable,
  videoStudiosTable,
  videoStatsTable,
} from "@/database/schema";
import type { ListVideosOptions } from "./videos.types";

/**
 * Build Drizzle WHERE conditions from ListVideosOptions
 * Reusable helper for list(), getNextVideo(), and getTriageQueue()
 */
export function buildVideoFilters(
  userId: number,
  options: ListVideosOptions
): {
  conditions: SQL[];
} {
  const {
    directory_id,
    search,
    searchFullPath = false,
    ids,
    include_hidden = false,
    createdFrom,
    createdBefore,
    minPlayCount,
    maxPlayCount,
    lastPlayedBefore,
    lastPlayedAfter,
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
    isFavorite,
    hasThumbnail,
    isAvailable,
    // Relationship presence filters
    hasTags,
    hasCreator,
    hasStudio,
    studioAssignmentStatus,
    hasRating,
  } = options;

  const conditions: SQL[] = [];

  // Availability filter
  if (isAvailable !== undefined) {
    conditions.push(eq(videosTable.isAvailable, isAvailable));
  } else if (!include_hidden) {
    conditions.push(eq(videosTable.isAvailable, true));
  }

  if (isFavorite !== undefined) {
    const favorite = sql`EXISTS (SELECT 1 FROM ${favoritesTable}
      WHERE ${favoritesTable.videoId} = ${videosTable.id}
        AND ${favoritesTable.userId} = ${userId})`;
    conditions.push(isFavorite ? favorite : sql`NOT ${favorite}`);
  }
  if (hasThumbnail !== undefined) {
    const thumbnail = sql`EXISTS (SELECT 1 FROM ${thumbnailsTable}
      WHERE ${thumbnailsTable.videoId} = ${videosTable.id})`;
    conditions.push(hasThumbnail ? thumbnail : sql`NOT ${thumbnail}`);
  }

  // Directory filter
  if (directory_id) {
    conditions.push(eq(videosTable.directoryId, directory_id));
  }

  // IDs filter
  if (ids && ids.length > 0) {
    conditions.push(inArray(videosTable.id, ids));
  }

  // Added-date range (inclusive start, exclusive end)
  if (createdFrom !== undefined) {
    conditions.push(gte(videosTable.createdAt, new Date(createdFrom)));
  }
  if (createdBefore !== undefined) {
    conditions.push(lt(videosTable.createdAt, new Date(createdBefore)));
  }

  const playCountExpression = sql`COALESCE((
    SELECT ${videoStatsTable.playCount}
    FROM ${videoStatsTable}
    WHERE ${videoStatsTable.videoId} = ${videosTable.id}
      AND ${videoStatsTable.userId} = ${userId}
  ), 0)`;
  if (minPlayCount !== undefined) {
    conditions.push(sql`${playCountExpression} >= ${minPlayCount}`);
  }
  if (maxPlayCount !== undefined) {
    conditions.push(sql`${playCountExpression} <= ${maxPlayCount}`);
  }
  if (lastPlayedBefore !== undefined) {
    conditions.push(sql`EXISTS (
      SELECT 1 FROM ${videoStatsTable}
      WHERE ${videoStatsTable.videoId} = ${videosTable.id}
        AND ${videoStatsTable.userId} = ${userId}
        AND ${videoStatsTable.lastPlayedAt} < ${lastPlayedBefore}::timestamptz
    )`);
  }
  if (lastPlayedAfter !== undefined) {
    conditions.push(sql`EXISTS (
      SELECT 1 FROM ${videoStatsTable}
      WHERE ${videoStatsTable.videoId} = ${videosTable.id}
        AND ${videoStatsTable.userId} = ${userId}
        AND ${videoStatsTable.lastPlayedAt} >= ${lastPlayedAfter}::timestamptz
    )`);
  }

  // Search filter
  if (search) {
    const searchPattern = `%${search}%`;
    const searchConditions = [
      ilike(videosTable.title, searchPattern),
      ilike(videosTable.description, searchPattern),
      ilike(videosTable.fileName, searchPattern),
    ];

    if (searchFullPath) {
      searchConditions.push(ilike(videosTable.filePath, searchPattern));
    }

    conditions.push(or(...searchConditions)!);
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
      sql`LOWER(${videosTable.audioCodec}) = LOWER(${audioCodec})`
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

  // Ratings are library-wide (the ratings table has no user_id).
  const averageRating = sql`(SELECT AVG(${ratingsTable.rating}) FROM ${ratingsTable} WHERE ${ratingsTable.videoId} = ${videosTable.id})`;
  if (minRating !== undefined) conditions.push(gte(averageRating, minRating));
  if (maxRating !== undefined) conditions.push(lte(averageRating, maxRating));

  for (const [ids, table, column, videoColumn] of [
    [
      creatorIds,
      videoCreatorsTable,
      videoCreatorsTable.creatorId,
      videoCreatorsTable.videoId,
    ],
    [
      studioIds,
      videoStudiosTable,
      videoStudiosTable.studioId,
      videoStudiosTable.videoId,
    ],
  ] as const) {
    const selected = [...new Set(ids ?? [])];
    if (!selected.length) continue;
    const predicate = sql`${videoColumn} = ${videosTable.id} AND ${inArray(column, selected)}`;
    conditions.push(
      matchMode === "all"
        ? sql`(SELECT COUNT(DISTINCT ${column}) FROM ${table} WHERE ${predicate}) = ${selected.length}`
        : sql`EXISTS (SELECT 1 FROM ${table} WHERE ${predicate})`
    );
  }

  const selectedTags = [...new Set(tagIds ?? [])];
  if (selectedTags.length) {
    // Each selected parent represents its subtree. ALL means one match for
    // every selected root, not a requirement to attach every descendant tag.
    conditions.push(sql`${videosTable.id} IN (
      WITH RECURSIVE selected_tags(id, root_id) AS (
        SELECT ${tagsTable.id}, ${tagsTable.id} FROM ${tagsTable} WHERE ${inArray(tagsTable.id, selectedTags)}
        UNION
        SELECT child.id, selected_tags.root_id FROM ${tagsTable} child
        JOIN selected_tags ON child.parent_id = selected_tags.id
      )
      SELECT ${videoTagsTable.videoId} FROM ${videoTagsTable} JOIN selected_tags ON selected_tags.id = ${videoTagsTable.tagId}
      ${matchMode === "all" ? sql`GROUP BY ${videoTagsTable.videoId} HAVING COUNT(DISTINCT selected_tags.root_id) = ${selectedTags.length}` : sql``}
    )`);
  }

  // Relationship presence filters (using EXISTS subqueries)
  if (hasTags === true) {
    conditions.push(
      sql`EXISTS (SELECT 1 FROM ${videoTagsTable} WHERE ${videoTagsTable.videoId} = ${videosTable.id})`
    );
  } else if (hasTags === false) {
    conditions.push(
      sql`NOT EXISTS (SELECT 1 FROM ${videoTagsTable} WHERE ${videoTagsTable.videoId} = ${videosTable.id})`
    );
  }

  if (hasCreator === true) {
    conditions.push(
      sql`EXISTS (SELECT 1 FROM ${videoCreatorsTable} WHERE ${videoCreatorsTable.videoId} = ${videosTable.id})`
    );
  } else if (hasCreator === false) {
    conditions.push(
      sql`NOT EXISTS (SELECT 1 FROM ${videoCreatorsTable} WHERE ${videoCreatorsTable.videoId} = ${videosTable.id})`
    );
  }

  if (hasStudio === true) {
    conditions.push(
      sql`EXISTS (SELECT 1 FROM ${videoStudiosTable} WHERE ${videoStudiosTable.videoId} = ${videosTable.id})`
    );
  } else if (hasStudio === false) {
    conditions.push(
      sql`NOT EXISTS (SELECT 1 FROM ${videoStudiosTable} WHERE ${videoStudiosTable.videoId} = ${videosTable.id})`
    );
  }

  if (studioAssignmentStatus === "assigned") {
    conditions.push(
      sql`EXISTS (SELECT 1 FROM ${videoStudiosTable} WHERE ${videoStudiosTable.videoId} = ${videosTable.id})`
    );
  } else if (studioAssignmentStatus === "confirmed_none") {
    conditions.push(
      sql`NOT EXISTS (SELECT 1 FROM ${videoStudiosTable} WHERE ${videoStudiosTable.videoId} = ${videosTable.id}) AND ${videosTable.studioAbsenceConfirmedAt} IS NOT NULL`
    );
  } else if (studioAssignmentStatus === "unknown") {
    conditions.push(
      sql`NOT EXISTS (SELECT 1 FROM ${videoStudiosTable} WHERE ${videoStudiosTable.videoId} = ${videosTable.id}) AND ${videosTable.studioAbsenceConfirmedAt} IS NULL`
    );
  }

  if (hasRating === true) {
    conditions.push(
      sql`EXISTS (SELECT 1 FROM ${ratingsTable} WHERE ${ratingsTable.videoId} = ${videosTable.id})`
    );
  } else if (hasRating === false) {
    conditions.push(
      sql`NOT EXISTS (SELECT 1 FROM ${ratingsTable} WHERE ${ratingsTable.videoId} = ${videosTable.id})`
    );
  }

  return {
    conditions,
  };
}

/**
 * Get valid sort column for videos table
 */
export function getValidSortColumn(
  sort: string
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
