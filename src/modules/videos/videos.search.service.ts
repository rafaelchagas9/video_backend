import {
  SQL,
  and,
  or,
  eq,
  gte,
  lte,
  sql,
  inArray,
  desc,
  asc,
} from "drizzle-orm";
import { db } from "@/config/drizzle";
import { env } from "@/config/env";
import {
  videosTable,
  thumbnailsTable,
  favoritesTable,
  ratingsTable,
  videoCreatorsTable,
  videoTagsTable,
  videoStudiosTable,
} from "@/database/schema";
import { API_PREFIX } from "@/config/constants";
import { tagsService } from "@/modules/tags/tags.service";
import { videoCollectionsService } from "@/modules/video-collections/video-collections.service";
import { creatorsRelationshipsService } from "@/modules/creators/creators.relationships.service";
import { studiosRelationshipsService } from "@/modules/studios/studios.relationships.service";
import { artworkService } from "@/modules/artwork/artwork.service";
import type {
  ListVideosOptions,
  NextVideoOptions,
  NextVideoResult,
  TriageQueueOptions,
  TriageQueueResult,
  Video,
  VideoListInclude,
} from "./videos.types";
import { buildVideoFilters, getValidSortColumn } from "./videos.query-builder";

interface PaginatedVideos {
  data: Video[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

/**
 * Service for video search, list, and navigation operations
 */
export class VideosSearchService {
  private async expandTagIds(tagIds?: number[]): Promise<number[] | undefined> {
    if (!tagIds || tagIds.length === 0) return tagIds;
    const expanded = new Set(tagIds);
    for (const id of tagIds) {
      const descendants = await tagsService.getDescendants(id);
      descendants.forEach((d) => expanded.add(d.id));
    }
    return Array.from(expanded);
  }

  private async checkIsFavoritesBatch(
    userId: number,
    videoIds: number[],
  ): Promise<Set<number>> {
    if (videoIds.length === 0) return new Set();
    const rows = await db
      .select({ videoId: favoritesTable.videoId })
      .from(favoritesTable)
      .where(
        and(
          eq(favoritesTable.userId, userId),
          inArray(favoritesTable.videoId, videoIds),
        ),
      );
    return new Set(rows.map((r) => r.videoId));
  }

  /**
   * List videos with pagination and filtering
   */
  async list(
    userId: number,
    options: ListVideosOptions = {},
  ): Promise<PaginatedVideos> {
    if (env.DEMO_MODE) {
      const { demoMockService } = await import("@/utils/demo-mock");
      const result = demoMockService.getVideos(options) as PaginatedVideos;
      if (options.include?.includes("artwork")) {
        const summaries = await artworkService.getSummariesByVideoIds(
          result.data.map((video) => video.id),
        );
        result.data = result.data.map((video) => ({
          ...video,
          artwork: summaries.get(video.id) ?? null,
        }));
      }
      return result;
    }
    const {
      page = 1,
      limit = 20,
      sort = "created_at",
      order = "desc",
      creatorIds,
      studioIds,
      isFavorite,
      hasThumbnail,
      minRating,
      maxRating,
      include = [],
    } = options;

    const tagIds = await this.expandTagIds(options.tagIds);
    const resolvedOptions = { ...options, tagIds };

    const offset = (page - 1) * limit;

    // Build filter conditions
    const {
      conditions,
      needsCreatorJoin,
      needsTagJoin,
      needsStudioJoin,
      needsRatingJoin,
      matchMode,
    } = buildVideoFilters(userId, resolvedOptions);

    // Get sort column
    const sortColumn = getValidSortColumn(sort);
    const sortOrder = order === "asc" ? asc : desc;

    // For 'all' match mode, we need GROUP BY + HAVING
    const needsGroupBy =
      matchMode === "all" &&
      (needsCreatorJoin || needsTagJoin || needsStudioJoin);

    // Build the base query
    let query = db
      .select({
        id: videosTable.id,
        filePath: videosTable.filePath,
        fileName: videosTable.fileName,
        directoryId: videosTable.directoryId,
        fileSizeBytes: videosTable.fileSizeBytes,
        fileHash: videosTable.fileHash,
        durationSeconds: videosTable.durationSeconds,
        width: videosTable.width,
        height: videosTable.height,
        codec: videosTable.codec,
        bitrate: videosTable.bitrate,
        fps: videosTable.fps,
        audioCodec: videosTable.audioCodec,
        title: videosTable.title,
        description: videosTable.description,
        themes: videosTable.themes,
        isAvailable: videosTable.isAvailable,
        lastVerifiedAt: videosTable.lastVerifiedAt,
        indexedAt: videosTable.indexedAt,
        createdAt: videosTable.createdAt,
        updatedAt: videosTable.updatedAt,
        thumbnailId: thumbnailsTable.id,
        thumbnailFilePath: thumbnailsTable.filePath,
      })
      .from(videosTable)
      .leftJoin(thumbnailsTable, eq(videosTable.id, thumbnailsTable.videoId))
      .$dynamic();

    // Add JOINs based on filters
    if (isFavorite === true) {
      query = query.innerJoin(
        favoritesTable,
        and(
          eq(videosTable.id, favoritesTable.videoId),
          eq(favoritesTable.userId, userId),
        ),
      );
    } else if (isFavorite === false) {
      query = query.leftJoin(
        favoritesTable,
        and(
          eq(videosTable.id, favoritesTable.videoId),
          eq(favoritesTable.userId, userId),
        ),
      );
      conditions.push(sql`${favoritesTable.videoId} IS NULL`);
    }

    if (needsCreatorJoin && creatorIds && creatorIds.length > 0) {
      if (matchMode === "any") {
        query = query.innerJoin(
          videoCreatorsTable,
          and(
            eq(videosTable.id, videoCreatorsTable.videoId),
            inArray(videoCreatorsTable.creatorId, creatorIds),
          ),
        );
      } else {
        query = query.leftJoin(
          videoCreatorsTable,
          eq(videosTable.id, videoCreatorsTable.videoId),
        );
        conditions.push(
          or(
            inArray(videoCreatorsTable.creatorId, creatorIds),
            sql`${videoCreatorsTable.creatorId} IS NULL`,
          )!,
        );
      }
    }

    if (needsTagJoin && tagIds && tagIds.length > 0) {
      if (matchMode === "any") {
        query = query.innerJoin(
          videoTagsTable,
          and(
            eq(videosTable.id, videoTagsTable.videoId),
            inArray(videoTagsTable.tagId, tagIds),
          ),
        );
      } else {
        query = query.leftJoin(
          videoTagsTable,
          eq(videosTable.id, videoTagsTable.videoId),
        );
        conditions.push(
          or(
            inArray(videoTagsTable.tagId, tagIds),
            sql`${videoTagsTable.tagId} IS NULL`,
          )!,
        );
      }
    }

    if (needsStudioJoin && studioIds && studioIds.length > 0) {
      if (matchMode === "any") {
        query = query.innerJoin(
          videoStudiosTable,
          and(
            eq(videosTable.id, videoStudiosTable.videoId),
            inArray(videoStudiosTable.studioId, studioIds),
          ),
        );
      } else {
        query = query.leftJoin(
          videoStudiosTable,
          eq(videosTable.id, videoStudiosTable.videoId),
        );
        conditions.push(
          or(
            inArray(videoStudiosTable.studioId, studioIds),
            sql`${videoStudiosTable.studioId} IS NULL`,
          )!,
        );
      }
    }

    // Rating filter requires subquery
    if (needsRatingJoin) {
      const avgRatingSubquery = db
        .select({
          videoId: ratingsTable.videoId,
          avgRating: sql<number>`AVG(${ratingsTable.rating})`.as("avg_rating"),
        })
        .from(ratingsTable)
        .groupBy(ratingsTable.videoId)
        .as("r");

      query = query.leftJoin(
        avgRatingSubquery,
        eq(videosTable.id, avgRatingSubquery.videoId),
      );

      if (minRating !== undefined) {
        conditions.push(gte(avgRatingSubquery.avgRating, minRating));
      }
      if (maxRating !== undefined) {
        conditions.push(lte(avgRatingSubquery.avgRating, maxRating));
      }
    }

    // Thumbnail presence filter
    if (hasThumbnail === true) {
      conditions.push(sql`${thumbnailsTable.id} IS NOT NULL`);
    } else if (hasThumbnail === false) {
      conditions.push(sql`${thumbnailsTable.id} IS NULL`);
    }

    // Apply WHERE conditions
    if (conditions.length > 0) {
      query = query.where(and(...conditions));
    }

    // Handle GROUP BY for 'all' match mode
    if (needsGroupBy) {
      const havingConditions: SQL[] = [];

      if (creatorIds && creatorIds.length > 0) {
        havingConditions.push(
          sql`COUNT(DISTINCT ${videoCreatorsTable.creatorId}) >= ${creatorIds.length}`,
        );
      }
      if (tagIds && tagIds.length > 0) {
        havingConditions.push(
          sql`COUNT(DISTINCT ${videoTagsTable.tagId}) >= ${tagIds.length}`,
        );
      }
      if (studioIds && studioIds.length > 0) {
        havingConditions.push(
          sql`COUNT(DISTINCT ${videoStudiosTable.studioId}) >= ${studioIds.length}`,
        );
      }

      // For complex GROUP BY queries, use raw SQL
      const countResult = await db.execute<{ count: number }>(sql`
        SELECT COUNT(*) as count FROM (
          SELECT ${videosTable.id}
          FROM ${videosTable}
          LEFT JOIN ${thumbnailsTable} ON ${videosTable.id} = ${thumbnailsTable.videoId}
          ${needsCreatorJoin ? sql`LEFT JOIN ${videoCreatorsTable} ON ${videosTable.id} = ${videoCreatorsTable.videoId}` : sql``}
          ${needsTagJoin ? sql`LEFT JOIN ${videoTagsTable} ON ${videosTable.id} = ${videoTagsTable.videoId}` : sql``}
          ${needsStudioJoin ? sql`LEFT JOIN ${videoStudiosTable} ON ${videosTable.id} = ${videoStudiosTable.videoId}` : sql``}
          WHERE ${and(...conditions) || sql`TRUE`}
          GROUP BY ${videosTable.id}
          HAVING ${and(...havingConditions)}
        ) as subquery
      `);

      const total = Number(countResult[0]?.count || 0);
      const totalPages = Math.ceil(total / limit);

      // Get paginated results with GROUP BY
      const results = await db.execute<{
        id: number;
        file_path: string;
        file_name: string;
        directory_id: number;
        file_size_bytes: number;
        file_hash: string | null;
        duration_seconds: number | null;
        width: number | null;
        height: number | null;
        codec: string | null;
        bitrate: number | null;
        fps: number | null;
        audio_codec: string | null;
        title: string | null;
        description: string | null;
        themes: string | null;
        is_available: boolean;
        last_verified_at: string | null;
        indexed_at: string;
        created_at: string;
        updated_at: string;
        thumbnail_id: number | null;
        thumbnail_file_path: string | null;
      }>(sql`
        SELECT DISTINCT ${videosTable.id}, ${videosTable.filePath} as file_path, ${videosTable.fileName} as file_name,
               ${videosTable.directoryId} as directory_id, ${videosTable.fileSizeBytes} as file_size_bytes, ${videosTable.fileHash} as file_hash,
               ${videosTable.durationSeconds} as duration_seconds, ${videosTable.width}, ${videosTable.height},
               ${videosTable.codec}, ${videosTable.bitrate}, ${videosTable.fps},
               ${videosTable.audioCodec} as audio_codec, ${videosTable.title}, ${videosTable.description},
               ${videosTable.themes}, ${videosTable.isAvailable} as is_available, ${videosTable.lastVerifiedAt} as last_verified_at,
               ${videosTable.indexedAt} as indexed_at, ${videosTable.createdAt} as created_at, ${videosTable.updatedAt} as updated_at,
               ${thumbnailsTable.id} as thumbnail_id, ${thumbnailsTable.filePath} as thumbnail_file_path
        FROM ${videosTable}
        LEFT JOIN ${thumbnailsTable} ON ${videosTable.id} = ${thumbnailsTable.videoId}
        ${needsCreatorJoin ? sql`LEFT JOIN ${videoCreatorsTable} ON ${videosTable.id} = ${videoCreatorsTable.videoId}` : sql``}
        ${needsTagJoin ? sql`LEFT JOIN ${videoTagsTable} ON ${videosTable.id} = ${videoTagsTable.videoId}` : sql``}
        ${needsStudioJoin ? sql`LEFT JOIN ${videoStudiosTable} ON ${videosTable.id} = ${videoStudiosTable.videoId}` : sql``}
        WHERE ${and(...conditions) || sql`TRUE`}
        GROUP BY ${videosTable.id}, ${thumbnailsTable.id}, ${thumbnailsTable.filePath}
        HAVING ${and(...havingConditions)}
        ORDER BY ${videosTable[sortColumn]} ${sql.raw(order === "asc" ? "ASC" : "DESC")}
        LIMIT ${limit} OFFSET ${offset}
      `);

      // Check favorites for all videos in a single query
      const favoriteIdsSet = await this.checkIsFavoritesBatch(
        userId,
        results.map((v) => v.id),
      );

      const videosWithFavorites = results.map((v) => ({
        ...v,
        is_favorite: favoriteIdsSet.has(v.id),
        thumbnail_url: v.thumbnail_id
          ? `${API_PREFIX}/thumbnails/${v.thumbnail_id}/image`
          : null,
      }));

      const enrichedVideos = await this.attachIncludes(
        videosWithFavorites as Video[],
        include,
      );

      return {
        data: enrichedVideos,
        pagination: {
          page,
          limit,
          total,
          totalPages,
        },
      };
    }

    // Simpler case without GROUP BY
    const countQuery = db
      .select({ count: sql<number>`count(*)`.as("count") })
      .from(videosTable)
      .leftJoin(thumbnailsTable, eq(videosTable.id, thumbnailsTable.videoId))
      .$dynamic();

    // Apply same joins for count
    let countQueryWithJoins = countQuery;
    if (isFavorite === true) {
      countQueryWithJoins = countQueryWithJoins.innerJoin(
        favoritesTable,
        and(
          eq(videosTable.id, favoritesTable.videoId),
          eq(favoritesTable.userId, userId),
        ),
      );
    }

    if (needsCreatorJoin && creatorIds && creatorIds.length > 0) {
      if (matchMode === "any") {
        countQueryWithJoins = countQueryWithJoins.innerJoin(
          videoCreatorsTable,
          and(
            eq(videosTable.id, videoCreatorsTable.videoId),
            inArray(videoCreatorsTable.creatorId, creatorIds),
          ),
        );
      } else {
        countQueryWithJoins = countQueryWithJoins.leftJoin(
          videoCreatorsTable,
          eq(videosTable.id, videoCreatorsTable.videoId),
        );
      }
    }

    if (needsTagJoin && tagIds && tagIds.length > 0) {
      if (matchMode === "any") {
        countQueryWithJoins = countQueryWithJoins.innerJoin(
          videoTagsTable,
          and(
            eq(videosTable.id, videoTagsTable.videoId),
            inArray(videoTagsTable.tagId, tagIds),
          ),
        );
      } else {
        countQueryWithJoins = countQueryWithJoins.leftJoin(
          videoTagsTable,
          eq(videosTable.id, videoTagsTable.videoId),
        );
      }
    }

    if (needsStudioJoin && studioIds && studioIds.length > 0) {
      if (matchMode === "any") {
        countQueryWithJoins = countQueryWithJoins.innerJoin(
          videoStudiosTable,
          and(
            eq(videosTable.id, videoStudiosTable.videoId),
            inArray(videoStudiosTable.studioId, studioIds),
          ),
        );
      } else {
        countQueryWithJoins = countQueryWithJoins.leftJoin(
          videoStudiosTable,
          eq(videosTable.id, videoStudiosTable.videoId),
        );
      }
    }

    if (conditions.length > 0) {
      countQueryWithJoins = countQueryWithJoins.where(and(...conditions));
    }

    const countResult = await countQueryWithJoins;
    const total = Number(countResult[0]?.count || 0);
    const totalPages = Math.ceil(total / limit);

    // Get paginated results
    const videos = await query
      .orderBy(sortOrder(videosTable[sortColumn]))
      .limit(limit)
      .offset(offset);

    // Check favorites for all videos in a single query
    const favoriteIds = await this.checkIsFavoritesBatch(
      userId,
      videos.map((v) => v.id),
    );

    const videosWithFavorites = videos.map((v) => {
        const isFav = favoriteIds.has(v.id);

        return {
          id: v.id,
          file_path: v.filePath,
          file_name: v.fileName,
          directory_id: v.directoryId,
          file_size_bytes: v.fileSizeBytes,
          file_hash: v.fileHash,
          duration_seconds: v.durationSeconds,
          width: v.width,
          height: v.height,
          codec: v.codec,
          bitrate: v.bitrate,
          fps: v.fps,
          audio_codec: v.audioCodec,
          title: v.title,
          description: v.description,
          themes: v.themes,
          is_available: v.isAvailable,
          last_verified_at: v.lastVerifiedAt?.toISOString() ?? null,
          indexed_at: v.indexedAt.toISOString(),
          created_at: v.createdAt.toISOString(),
          updated_at: v.updatedAt.toISOString(),
          is_favorite: isFav,
          thumbnail_id: v.thumbnailId,
          thumbnail_url: v.thumbnailId
            ? `${API_PREFIX}/thumbnails/${v.thumbnailId}/image`
            : null,
        };
      });

    const enrichedVideos = await this.attachIncludes(
      videosWithFavorites as Video[],
      include,
    );

    return {
      data: enrichedVideos,
      pagination: {
        page,
        limit,
        total,
        totalPages,
      },
    };
  }

  private async attachIncludes(
    videos: Video[],
    include: VideoListInclude[],
  ): Promise<Video[]> {
    if (videos.length === 0 || include.length === 0) {
      return videos;
    }

    const videoIds = videos.map((video) => video.id);
    const [collections, creators, tags, studios, artwork] = await Promise.all([
      include.includes("collection")
        ? videoCollectionsService.getCollectionContextsByVideoIds(videoIds)
        : Promise.resolve(new Map()),
      include.includes("creators")
        ? creatorsRelationshipsService.getCreatorsForVideos(videoIds)
        : Promise.resolve(new Map()),
      include.includes("tags")
        ? tagsService.getTagsForVideos(videoIds)
        : Promise.resolve(new Map()),
      include.includes("studios")
        ? studiosRelationshipsService.getStudiosForVideos(videoIds)
        : Promise.resolve(new Map()),
      include.includes("artwork")
        ? artworkService.getSummariesByVideoIds(videoIds)
        : Promise.resolve(new Map()),
    ]);

    return videos.map((video) => ({
      ...video,
      ...(include.includes("collection")
        ? { collection: collections.get(video.id) ?? null }
        : {}),
      ...(include.includes("creators")
        ? { creators: creators.get(video.id) ?? [] }
        : {}),
      ...(include.includes("tags") ? { tags: tags.get(video.id) ?? [] } : {}),
      ...(include.includes("studios")
        ? { studios: studios.get(video.id) ?? [] }
        : {}),
      ...(include.includes("artwork")
        ? { artwork: artwork.get(video.id) ?? null }
        : {}),
    }));
  }

  /**
   * Get next/previous video with wraparound
   */
  async getNextVideo(
    userId: number,
    options: NextVideoOptions,
  ): Promise<NextVideoResult> {
    if (env.DEMO_MODE) {
      const { demoMockService } = await import("@/utils/demo-mock");
      const result = demoMockService.getVideos({ ...options, limit: 10_000 });
      const currentIndex = result.data.findIndex(
        (video: Video) => video.id === options.currentId,
      );
      if (currentIndex < 0 || result.data.length === 0) {
        return {
          video: null,
          meta: {
            remaining: 0,
            total_matching: result.pagination.total,
            has_wrapped: false,
          },
        };
      }

      const delta = options.direction === "previous" ? -1 : 1;
      const unwrappedIndex = currentIndex + delta;
      const hasWrapped =
        unwrappedIndex < 0 || unwrappedIndex >= result.data.length;
      const nextIndex =
        (unwrappedIndex + result.data.length) % result.data.length;

      return {
        video: result.data[nextIndex] ?? null,
        meta: {
          remaining: Math.max(0, result.data.length - 1),
          total_matching: result.pagination.total,
          has_wrapped: hasWrapped,
        },
      };
    }

    const {
      currentId,
      direction = "next",
      sort = "created_at",
      order = "desc",
    } = options;

    // Import here to avoid circular dependency
    const { videosService } = await import("./videos.service");

    // Get current video to extract sort value
    const currentVideo = await videosService.findById(currentId, userId);

    const sortColumn = getValidSortColumn(sort);
    const responseSortColumnMap: Record<string, string> = {
      createdAt: "created_at",
      fileName: "file_name",
      durationSeconds: "duration_seconds",
      fileSizeBytes: "file_size_bytes",
      indexedAt: "indexed_at",
    };
    const currentVideoRecord = currentVideo as unknown as Record<
      string,
      unknown
    >;
    let currentSortValue =
      currentVideoRecord[sortColumn] ??
      currentVideoRecord[responseSortColumnMap[sortColumn] ?? sortColumn];

    if (
      (sortColumn === "createdAt" || sortColumn === "indexedAt") &&
      typeof currentSortValue === "string"
    ) {
      currentSortValue = new Date(currentSortValue);
    }

    // Build filter conditions
    const { conditions } = buildVideoFilters(userId, options);

    // Determine comparison operators
    const isDescending = order === "desc";
    const isNext = direction === "next";

    let comparisonOp: SQL;
    let sortDirection: typeof asc | typeof desc;

    if (isNext) {
      if (isDescending) {
        comparisonOp = lte(
          videosTable[sortColumn],
          currentSortValue as number | string | Date,
        );
        sortDirection = desc;
      } else {
        comparisonOp = gte(
          videosTable[sortColumn],
          currentSortValue as number | string | Date,
        );
        sortDirection = asc;
      }
    } else {
      if (isDescending) {
        comparisonOp = gte(
          videosTable[sortColumn],
          currentSortValue as number | string | Date,
        );
        sortDirection = asc;
      } else {
        comparisonOp = lte(
          videosTable[sortColumn],
          currentSortValue as number | string | Date,
        );
        sortDirection = desc;
      }
    }

    // Try to find next video
    const positionalConditions = [
      ...conditions,
      or(
        comparisonOp,
        and(
          eq(videosTable[sortColumn], currentSortValue as number | string | Date),
          isNext
            ? gte(videosTable.id, currentId)
            : lte(videosTable.id, currentId),
        ),
      )!,
      sql`${videosTable.id} != ${currentId}`,
    ];

    const nextVideoResult = await db
      .select({
        id: videosTable.id,
        filePath: videosTable.filePath,
        fileName: videosTable.fileName,
        directoryId: videosTable.directoryId,
        fileSizeBytes: videosTable.fileSizeBytes,
        fileHash: videosTable.fileHash,
        durationSeconds: videosTable.durationSeconds,
        width: videosTable.width,
        height: videosTable.height,
        codec: videosTable.codec,
        bitrate: videosTable.bitrate,
        fps: videosTable.fps,
        audioCodec: videosTable.audioCodec,
        title: videosTable.title,
        description: videosTable.description,
        themes: videosTable.themes,
        isAvailable: videosTable.isAvailable,
        lastVerifiedAt: videosTable.lastVerifiedAt,
        indexedAt: videosTable.indexedAt,
        createdAt: videosTable.createdAt,
        updatedAt: videosTable.updatedAt,
        thumbnailId: thumbnailsTable.id,
        thumbnailFilePath: thumbnailsTable.filePath,
      })
      .from(videosTable)
      .leftJoin(thumbnailsTable, eq(videosTable.id, thumbnailsTable.videoId))
      .where(and(...positionalConditions))
      .orderBy(
        sortDirection(videosTable[sortColumn]),
        sortDirection(videosTable.id),
      )
      .limit(1);

    let nextVideo = nextVideoResult[0];
    let hasWrapped = false;

    // If no video found, wrap around
    if (!nextVideo) {
      hasWrapped = true;
      const wrapDirection = isNext
        ? isDescending
          ? desc
          : asc
        : isDescending
          ? asc
          : desc;

      const wrapResult = await db
        .select({
          id: videosTable.id,
          filePath: videosTable.filePath,
          fileName: videosTable.fileName,
          directoryId: videosTable.directoryId,
          fileSizeBytes: videosTable.fileSizeBytes,
          fileHash: videosTable.fileHash,
          durationSeconds: videosTable.durationSeconds,
          width: videosTable.width,
          height: videosTable.height,
          codec: videosTable.codec,
          bitrate: videosTable.bitrate,
          fps: videosTable.fps,
          audioCodec: videosTable.audioCodec,
          title: videosTable.title,
          description: videosTable.description,
          themes: videosTable.themes,
          isAvailable: videosTable.isAvailable,
          lastVerifiedAt: videosTable.lastVerifiedAt,
          indexedAt: videosTable.indexedAt,
          createdAt: videosTable.createdAt,
          updatedAt: videosTable.updatedAt,
          thumbnailId: thumbnailsTable.id,
          thumbnailFilePath: thumbnailsTable.filePath,
        })
        .from(videosTable)
        .leftJoin(thumbnailsTable, eq(videosTable.id, thumbnailsTable.videoId))
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(
          wrapDirection(videosTable[sortColumn]),
          wrapDirection(videosTable.id),
        )
        .limit(1);

      nextVideo = wrapResult[0];
    }

    // Get total and remaining counts
    const totalCountResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(videosTable)
      .where(conditions.length > 0 ? and(...conditions) : undefined);

    const remainingCountResult = hasWrapped
      ? [{ count: totalCountResult[0].count - 1 }]
      : await db
          .select({ count: sql<number>`count(*)` })
          .from(videosTable)
          .where(and(...positionalConditions));

    // Prepare video response
    let videoResponse: Video | null = null;
    if (nextVideo) {
      const favSet = await this.checkIsFavoritesBatch(userId, [nextVideo.id]);
      const isFav = favSet.has(nextVideo.id);

      videoResponse = {
        id: nextVideo.id,
        file_path: nextVideo.filePath,
        file_name: nextVideo.fileName,
        directory_id: nextVideo.directoryId,
        file_size_bytes: nextVideo.fileSizeBytes,
        file_hash: nextVideo.fileHash,
        duration_seconds: nextVideo.durationSeconds,
        width: nextVideo.width,
        height: nextVideo.height,
        codec: nextVideo.codec,
        bitrate: nextVideo.bitrate,
        fps: nextVideo.fps,
        audio_codec: nextVideo.audioCodec,
        title: nextVideo.title,
        description: nextVideo.description,
        themes: nextVideo.themes,
        is_available: nextVideo.isAvailable,
        last_verified_at: nextVideo.lastVerifiedAt?.toISOString() ?? null,
        indexed_at: nextVideo.indexedAt.toISOString(),
        created_at: nextVideo.createdAt.toISOString(),
        updated_at: nextVideo.updatedAt.toISOString(),
        is_favorite: isFav,
        thumbnail_id: nextVideo.thumbnailId,
        thumbnail_url: nextVideo.thumbnailId
          ? `${API_PREFIX}/thumbnails/${nextVideo.thumbnailId}/image`
          : null,
      } as Video;
    }

    return {
      video: videoResponse,
      meta: {
        remaining: Number(remainingCountResult[0]?.count || 0),
        total_matching: Number(totalCountResult[0]?.count || 0),
        has_wrapped: hasWrapped,
      },
    };
  }

  /**
   * Get triage queue (ordered video IDs)
   */
  async getTriageQueue(
    userId: number,
    options: TriageQueueOptions,
  ): Promise<TriageQueueResult> {
    if (env.DEMO_MODE) {
      const { demoMockService } = await import("@/utils/demo-mock");
      const queueOffset = options.queueOffset ?? 0;
      const queueLimit = options.queueLimit ?? 100;
      const result = demoMockService.getVideos({
        ...options,
        page: 1,
        limit: 10_000,
      });
      return {
        ids: result.data
          .slice(queueOffset, queueOffset + queueLimit)
          .map((video: Video) => video.id),
        total: result.pagination.total,
      };
    }

    const {
      queueLimit = 100,
      queueOffset = 0,
      sort = "created_at",
      order = "desc",
    } = options;

    // Build filter conditions
    const { conditions } = buildVideoFilters(userId, options);

    // Get sort column
    const sortColumn = getValidSortColumn(sort);
    const sortDirection = order === "asc" ? asc : desc;

    // Get total count
    const totalCountResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(videosTable)
      .where(conditions.length > 0 ? and(...conditions) : undefined);

    // Get ordered IDs
    const ids = await db
      .select({ id: videosTable.id })
      .from(videosTable)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(
        sortDirection(videosTable[sortColumn]),
        sortDirection(videosTable.id),
      )
      .limit(queueLimit)
      .offset(queueOffset);

    return {
      ids: ids.map((row) => row.id),
      total: Number(totalCountResult[0]?.count || 0),
    };
  }
}

export const videosSearchService = new VideosSearchService();
