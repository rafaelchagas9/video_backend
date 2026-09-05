import {
  and,
  or,
  eq,
  gt,
  lt,
  isNull,
  isNotNull,
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
  videoStudiosTable,
} from "@/database/schema";
import { API_PREFIX } from "@/config/constants";
import { tagsService } from "@/modules/tags/tags.service";
import { videoCollectionsService } from "@/modules/video-collections/video-collections.service";
import { creatorsRelationshipsService } from "@/modules/creators/creators.relationships.service";
import { studiosRelationshipsService } from "@/modules/studios/studios.relationships.service";
import { artworkService } from "@/modules/artwork/artwork.service";
import { videoStatsService } from "@/modules/video-stats/video-stats.service";
import type {
  ListVideosOptions,
  NextVideoOptions,
  NextVideoResult,
  TriageQueueOptions,
  TriageQueueResult,
  Video,
  VideoListInclude,
} from "./videos.types";
import type { StudioAssignmentStatus } from "./videos.types";
import { buildVideoFilters, getValidSortColumn } from "./videos.query-builder";

const studioAssignmentStatusSql = sql<StudioAssignmentStatus>`CASE
  WHEN EXISTS (SELECT 1 FROM ${videoStudiosTable} vs_status WHERE vs_status.video_id = ${videosTable.id}) THEN 'assigned'
  WHEN ${videosTable.studioAbsenceConfirmedAt} IS NOT NULL THEN 'confirmed_none'
  ELSE 'unknown'
END`;

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
  private async checkIsFavoritesBatch(
    userId: number,
    videoIds: number[]
  ): Promise<Set<number>> {
    if (videoIds.length === 0) return new Set();
    const rows = await db
      .select({ videoId: favoritesTable.videoId })
      .from(favoritesTable)
      .where(
        and(
          eq(favoritesTable.userId, userId),
          inArray(favoritesTable.videoId, videoIds)
        )
      );
    return new Set(rows.map((r) => r.videoId));
  }

  /**
   * List videos with pagination and filtering
   */
  async list(
    userId: number,
    options: ListVideosOptions = {}
  ): Promise<PaginatedVideos> {
    if (env.DEMO_MODE) {
      const { demoRepository } = await import("@/database/demo/repository");
      const result = demoRepository.getVideos(options) as PaginatedVideos;
      result.data = await this.attachIncludes(
        result.data,
        options.include ?? [],
        userId
      );
      return result;
    }
    const {
      page = 1,
      limit = 20,
      sort = "created_at",
      order = "desc",
      include = [],
    } = options;

    const offset = (page - 1) * limit;

    // Build filter conditions
    const { conditions } = buildVideoFilters(userId, options);

    // Get sort column
    const sortColumn = getValidSortColumn(sort);
    const sortOrder = order === "asc" ? asc : desc;

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
        studioAssignmentStatus: studioAssignmentStatusSql,
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

    if (conditions.length) query = query.where(and(...conditions));
    const [count] = await db
      .select({ total: sql<number>`COUNT(*)` })
      .from(videosTable)
      .where(and(...conditions));
    const total = Number(count?.total ?? 0);
    const totalPages = Math.ceil(total / limit);

    // Get paginated results
    const videos = await query
      .orderBy(sortOrder(videosTable[sortColumn]), sortOrder(videosTable.id))
      .limit(limit)
      .offset(offset);

    // Check favorites for all videos in a single query
    const favoriteIds = await this.checkIsFavoritesBatch(
      userId,
      videos.map((v) => v.id)
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
        studio_assignment_status: v.studioAssignmentStatus,
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
      userId
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
    userId: number
  ): Promise<Video[]> {
    if (videos.length === 0 || include.length === 0) {
      return videos;
    }

    const videoIds = videos.map((video) => video.id);
    const [collections, creators, tags, studios, artwork, stats] =
      await Promise.all([
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
        include.includes("stats")
          ? videoStatsService.getSummariesForVideos(userId, videoIds)
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
      ...(include.includes("stats")
        ? (stats.get(video.id) ?? { play_count: 0, last_played_at: null })
        : {}),
    }));
  }

  /**
   * Get next/previous video with wraparound
   */
  async getNextVideo(
    userId: number,
    options: NextVideoOptions
  ): Promise<NextVideoResult> {
    if (env.DEMO_MODE) {
      const { demoRepository } = await import("@/database/demo/repository");
      const result = demoRepository.getVideos({ ...options, limit: 10_000 });
      const currentIndex = result.data.findIndex(
        (video: Video) => video.id === options.currentId
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

    const ascending = isNext !== isDescending;
    const sortDirection = ascending ? asc : desc;
    const column = videosTable[sortColumn];
    const idComparison = ascending
      ? gt(videosTable.id, currentId)
      : lt(videosTable.id, currentId);
    // PostgreSQL's default order puts NULL last ascending and first descending.
    // Treat unknown metadata as an ordered group, including its ID tie-break.
    const positionalComparison =
      currentSortValue == null
        ? ascending
          ? and(isNull(column), idComparison)
          : or(isNotNull(column), and(isNull(column), idComparison))
        : or(
            ascending
              ? gt(column, currentSortValue as number | string | Date)
              : lt(column, currentSortValue as number | string | Date),
            and(
              eq(column, currentSortValue as number | string | Date),
              idComparison
            ),
            ascending ? isNull(column) : undefined
          );
    const positionalConditions = [...conditions, positionalComparison!];

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
        studioAssignmentStatus: studioAssignmentStatusSql,
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
        sortDirection(videosTable.id)
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
          studioAssignmentStatus: studioAssignmentStatusSql,
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
          wrapDirection(videosTable.id)
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
        studio_assignment_status: nextVideo.studioAssignmentStatus,
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
        remaining: Math.max(0, Number(remainingCountResult[0]?.count || 0)),
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
    options: TriageQueueOptions
  ): Promise<TriageQueueResult> {
    if (env.DEMO_MODE) {
      const { demoRepository } = await import("@/database/demo/repository");
      const queueOffset = options.queueOffset ?? 0;
      const queueLimit = options.queueLimit ?? 100;
      const result = demoRepository.getVideos({
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
        sortDirection(videosTable.id)
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
