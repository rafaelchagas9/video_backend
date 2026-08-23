import { eq, sql, and, inArray, desc } from "drizzle-orm";
import { db } from "@/config/drizzle";
import { env } from "@/config/env";
import { demoRepository } from "@/database/demo";
import { videosDemoService } from "./videos.demo.service";
import { demoMediaAssetsService } from "@/modules/media/demo-media-assets.service";
import {
  videosTable,
  videoStatsTable,
  studiosTable,
  videoCreatorsTable,
  videoTagsTable,
  videoStudiosTable,
  thumbnailsTable,
  favoritesTable,
  storyboardsTable,
  watchedDirectoriesTable,
  videoFaceDetectionsTable,
  faceImagesTable,
  artworkAssetsTable,
} from "@/database/schema";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  isUniqueViolation,
} from "@/utils/errors";
import { API_PREFIX } from "@/config/constants";
import { logger } from "@/utils/logger";
import { existsSync, statSync } from "fs";
import { basename } from "path";
import type {
  RandomVideoOptions,
  Video,
  UpdateVideoInput,
  UnavailableVideo,
} from "./videos.types";
import { deriveStudioAssignmentStatus } from "./videos.types";
import { computeFileHash } from "@/utils/file-utils";
import { metadataService } from "./metadata.service";
import { thumbnailsService } from "@/modules/thumbnails/thumbnails.service";
import { videoCollectionsService } from "@/modules/video-collections/video-collections.service";
import { creatorsRelationshipsService } from "@/modules/creators/creators.relationships.service";
import { tagsService } from "@/modules/tags/tags.service";
import { studiosRelationshipsService } from "@/modules/studios/studios.relationships.service";
import { buildVideoFilters } from "./videos.query-builder";
import { videosBulkService } from "./videos.bulk.service";

// Import specialized services
export { videosSearchService } from "./videos.search.service";
export { videosSuggestionsService } from "./videos.suggestions.service";
export { videosMetadataService } from "./videos.metadata.service";
export { videosBulkService } from "./videos.bulk.service";
import type { VideoInclude } from "./videos.types";

/**
 * Main video service - Core CRUD operations
 */
export class VideosService {
  private async expandTagIds(tagIds?: number[]): Promise<number[] | undefined> {
    if (!tagIds || tagIds.length === 0) return tagIds;

    const expanded = new Set(tagIds);
    for (const id of tagIds) {
      const descendants = await tagsService.getDescendants(id);
      descendants.forEach((tag) => expanded.add(tag.id));
    }

    return Array.from(expanded);
  }

  /**
   * Find video file path and availability by ID (lightweight lookup for streaming)
   */
  async findFilePathById(
    id: number
  ): Promise<{ file_path: string; is_available: boolean }> {
    if (env.DEMO_MODE) {
      const { demoMockService } = await import("@/utils/demo-mock");
      const video = demoMockService.getVideoById(id);
      return {
        file_path: video.file_path,
        is_available: video.is_available,
      };
    }

    const results = await db
      .select({
        filePath: videosTable.filePath,
        isAvailable: videosTable.isAvailable,
      })
      .from(videosTable)
      .where(eq(videosTable.id, id))
      .limit(1);

    const video = results[0];
    if (!video) {
      throw new NotFoundError(`Video not found with id: ${id}`);
    }

    return {
      file_path: video.filePath,
      is_available: video.isAvailable,
    };
  }

  /** Find a production catalog entry by its exact local path. */
  async findByFilePath(filePath: string): Promise<Video | null> {
    if (env.DEMO_MODE) return null;
    const [row] = await db
      .select({ id: videosTable.id })
      .from(videosTable)
      .where(eq(videosTable.filePath, filePath))
      .limit(1);
    return row ? this.findById(row.id) : null;
  }

  /**
   * Find video by ID
   */
  async findById(
    id: number,
    userId?: number,
    include: VideoInclude[] = []
  ): Promise<Video> {
    if (env.DEMO_MODE) {
      const { demoMockService } = await import("@/utils/demo-mock");
      const video = demoMockService.getVideoById(id);
      if (!include.includes("artwork")) return video;
      const { artworkService } =
        await import("@/modules/artwork/artwork.service");
      const summaries = await artworkService.getSummariesByVideoIds([id]);
      return { ...video, artwork: summaries.get(id) ?? null };
    }
    const results = await db
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
        studioAbsenceConfirmedAt: videosTable.studioAbsenceConfirmedAt,
        hasStudio: sql<boolean>`EXISTS (SELECT 1 FROM ${videoStudiosTable} WHERE ${videoStudiosTable.videoId} = ${videosTable.id})`,
        lastVerifiedAt: videosTable.lastVerifiedAt,
        indexedAt: videosTable.indexedAt,
        createdAt: videosTable.createdAt,
        updatedAt: videosTable.updatedAt,
        thumbnailId: thumbnailsTable.id,
        thumbnailFilePath: thumbnailsTable.filePath,
      })
      .from(videosTable)
      .leftJoin(thumbnailsTable, eq(videosTable.id, thumbnailsTable.videoId))
      .where(eq(videosTable.id, id))
      .limit(1);

    const video = results[0];
    if (!video) {
      throw new NotFoundError(`Video not found with id: ${id}`);
    }

    let isFavorite = false;
    if (userId) {
      const favoriteCheck = await db
        .select({ id: favoritesTable.videoId })
        .from(favoritesTable)
        .where(
          and(eq(favoritesTable.userId, userId), eq(favoritesTable.videoId, id))
        )
        .limit(1);
      isFavorite = favoriteCheck.length > 0;
    }

    const response: Video = {
      id: video.id,
      file_path: video.filePath,
      file_name: video.fileName,
      directory_id: video.directoryId,
      file_size_bytes: video.fileSizeBytes,
      file_hash: video.fileHash,
      duration_seconds: video.durationSeconds,
      width: video.width,
      height: video.height,
      codec: video.codec,
      bitrate: video.bitrate,
      fps: video.fps,
      audio_codec: video.audioCodec,
      title: video.title,
      description: video.description,
      themes: video.themes,
      is_available: video.isAvailable,
      studio_assignment_status: deriveStudioAssignmentStatus(video.hasStudio, video.studioAbsenceConfirmedAt),
      last_verified_at: video.lastVerifiedAt?.toISOString() ?? null,
      indexed_at: video.indexedAt.toISOString(),
      created_at: video.createdAt.toISOString(),
      updated_at: video.updatedAt.toISOString(),
      is_favorite: isFavorite,
      thumbnail_id: video.thumbnailId,
      thumbnail_url: video.thumbnailId
        ? `${API_PREFIX}/thumbnails/${video.thumbnailId}/image`
        : null,
    } as Video;

    const promises: Promise<void>[] = [];

    if (include.includes("collection")) {
      promises.push(
        videoCollectionsService
          .getCollectionContextByVideoId(id)
          .then((res) => {
            response.collection = res;
          })
      );
    }

    if (include.includes("collection_neighbors")) {
      promises.push(
        videoCollectionsService.getNeighborsByVideoId(id).then((res) => {
          response.collection_neighbors = res;
        })
      );
    }

    if (include.includes("creators")) {
      promises.push(
        creatorsRelationshipsService.getCreatorsForVideo(id).then((res) => {
          response.creators = res;
        })
      );
    }

    if (include.includes("tags")) {
      promises.push(
        tagsService.getTagsForVideo(id).then((res) => {
          response.tags = res;
        })
      );
    }

    if (include.includes("studios")) {
      promises.push(
        studiosRelationshipsService.getStudiosForVideo(id).then((res) => {
          response.studios = res;
        })
      );
    }

    if (include.includes("artwork")) {
      promises.push(
        import("@/modules/artwork/artwork.service")
          .then(({ artworkService }) =>
            artworkService.getSummariesByVideoIds([id])
          )
          .then((summaries) => {
            response.artwork = summaries.get(id) ?? null;
          })
      );
    }

    if (promises.length > 0) {
      await Promise.all(promises);
    }

    return response;
  }

  /**
   * Get random video(s)
   */
  async getRandomVideo(
    userId: number,
    options: RandomVideoOptions = {}
  ): Promise<Video | Video[]> {
    if (env.DEMO_MODE) {
      const { demoMockService } = await import("@/utils/demo-mock");
      const videosObj = demoMockService.getVideos({
        ...options,
        limit: 100,
      });
      const list = videosObj.data;
      if (list.length === 0) {
        throw new NotFoundError("No matching videos found");
      }
      const shuffled = [...list].sort(() => 0.5 - Math.random());
      const limit = options.limit !== undefined ? options.limit : 1;
      const sliced = shuffled.slice(0, limit);
      if (options.limit !== undefined) {
        return sliced;
      }
      return sliced[0];
    }

    const tagIds = await this.expandTagIds(options.tagIds);
    const resolvedOptions = { ...options, tagIds };
    const { conditions } = buildVideoFilters(userId, resolvedOptions);
    const matchMode = resolvedOptions.matchMode ?? "any";

    if (
      resolvedOptions.creatorIds !== undefined &&
      resolvedOptions.creatorIds.length > 0
    ) {
      if (matchMode === "all") {
        conditions.push(sql`
          (
            SELECT COUNT(DISTINCT ${videoCreatorsTable.creatorId})
            FROM ${videoCreatorsTable}
            WHERE ${videoCreatorsTable.videoId} = ${videosTable.id}
              AND ${inArray(videoCreatorsTable.creatorId, resolvedOptions.creatorIds)}
          ) >= ${resolvedOptions.creatorIds.length}
        `);
      } else {
        conditions.push(sql`
          EXISTS (
            SELECT 1 FROM ${videoCreatorsTable}
            WHERE ${videoCreatorsTable.videoId} = ${videosTable.id}
              AND ${inArray(videoCreatorsTable.creatorId, resolvedOptions.creatorIds)}
          )
        `);
      }
    }

    if (tagIds !== undefined && tagIds.length > 0) {
      if (matchMode === "all") {
        conditions.push(sql`
          (
            SELECT COUNT(DISTINCT ${videoTagsTable.tagId})
            FROM ${videoTagsTable}
            WHERE ${videoTagsTable.videoId} = ${videosTable.id}
              AND ${inArray(videoTagsTable.tagId, tagIds)}
          ) >= ${tagIds.length}
        `);
      } else {
        conditions.push(sql`
          EXISTS (
            SELECT 1 FROM ${videoTagsTable}
            WHERE ${videoTagsTable.videoId} = ${videosTable.id}
              AND ${inArray(videoTagsTable.tagId, tagIds)}
          )
        `);
      }
    }

    if (
      resolvedOptions.studioIds !== undefined &&
      resolvedOptions.studioIds.length > 0
    ) {
      if (matchMode === "all") {
        conditions.push(sql`
          (
            SELECT COUNT(DISTINCT ${videoStudiosTable.studioId})
            FROM ${videoStudiosTable}
            WHERE ${videoStudiosTable.videoId} = ${videosTable.id}
              AND ${inArray(videoStudiosTable.studioId, resolvedOptions.studioIds)}
          ) >= ${resolvedOptions.studioIds.length}
        `);
      } else {
        conditions.push(sql`
          EXISTS (
            SELECT 1 FROM ${videoStudiosTable}
            WHERE ${videoStudiosTable.videoId} = ${videosTable.id}
              AND ${inArray(videoStudiosTable.studioId, resolvedOptions.studioIds)}
          )
        `);
      }
    }

    if (resolvedOptions.minPlayCount !== undefined) {
      conditions.push(sql`
        COALESCE(
          (
            SELECT ${videoStatsTable.playCount}
            FROM ${videoStatsTable}
            WHERE ${videoStatsTable.videoId} = ${videosTable.id}
              AND ${videoStatsTable.userId} = ${userId}
          ),
          0
        ) >= ${resolvedOptions.minPlayCount}
      `);
    }

    if (resolvedOptions.maxPlayCount !== undefined) {
      conditions.push(sql`
        COALESCE(
          (
            SELECT ${videoStatsTable.playCount}
            FROM ${videoStatsTable}
            WHERE ${videoStatsTable.videoId} = ${videosTable.id}
              AND ${videoStatsTable.userId} = ${userId}
          ),
          0
        ) <= ${resolvedOptions.maxPlayCount}
      `);
    }

    const limit =
      resolvedOptions.limit !== undefined ? resolvedOptions.limit : 1;

    const randomVideos = await db
      .select({ id: videosTable.id })
      .from(videosTable)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(sql`RANDOM()`)
      .limit(limit);

    if (!randomVideos || randomVideos.length === 0) {
      throw new NotFoundError("No matching videos found");
    }

    if (resolvedOptions.limit !== undefined) {
      return Promise.all(
        randomVideos.map((rv) => this.findById(rv.id, userId))
      );
    }

    return this.findById(randomVideos[0].id, userId);
  }

  /**
   * Update video
   */
  async update(id: number, input: UpdateVideoInput): Promise<Video> {
    if (env.DEMO_MODE) {
      videosDemoService.update(id, input);
      return demoRepository.getVideoById(id) as Video;
    }

    const updateData: Partial<typeof videosTable.$inferInsert> = {};

    if (input.title !== undefined) updateData.title = input.title;
    if (input.description !== undefined)
      updateData.description = input.description;
    if (input.themes !== undefined) updateData.themes = input.themes;

    if (Object.keys(updateData).length === 0) {
      return this.findById(id);
    }

    updateData.updatedAt = new Date();

    const [updated] = await db
      .update(videosTable)
      .set(updateData)
      .where(eq(videosTable.id, id))
      .returning({ id: videosTable.id });

    if (!updated) {
      throw new NotFoundError(`Video not found with id: ${id}`);
    }

    return this.findById(id);
  }

  /**
   * Delete video (including file and related data)
   */
  async delete(id: number): Promise<void> {
    if (env.DEMO_MODE) {
      videosDemoService.delete(id);
      return;
    }

    const video = await this.findById(id); // Ensure exists
    await videosBulkService.bulkDelete([video.id]);

    // Enrichment suggestions/runs are polymorphic (no FK) — clean up explicitly.
    const { enrichmentService } =
      await import("@/modules/enrichment/enrichment.service");
    await enrichmentService.deleteForEntity("scene", id);
  }

  /**
   * Verify video file availability
   */
  async verifyAvailability(id: number): Promise<Video> {
    if (env.DEMO_MODE) {
      videosDemoService.verifyAvailability({ videoId: id });
      return demoRepository.getVideoById(id) as Video;
    }

    const video = await this.findById(id);

    const fs = await import("fs");
    const exists = fs.existsSync(video.file_path);
    const lastVerifiedAt = new Date();

    await db
      .update(videosTable)
      .set({ isAvailable: exists, lastVerifiedAt })
      .where(eq(videosTable.id, id));

    return {
      ...video,
      is_available: exists,
      last_verified_at: lastVerifiedAt.toISOString(),
    };
  }

  /**
   * List videos currently marked unavailable (their source file is missing from
   * disk), enriched with a summary of the derived artifacts that can be reclaimed
   * by purging them.
   */
  async listUnavailable(options: {
    page: number;
    limit: number;
    directoryId?: number;
  }): Promise<{
    data: UnavailableVideo[];
    pagination: {
      page: number;
      limit: number;
      total: number;
      totalPages: number;
    };
  }> {
    const { page, limit, directoryId } = options;
    const offset = (page - 1) * limit;

    if (env.DEMO_MODE) {
      return videosDemoService.listUnavailable(options) as unknown as {
        data: UnavailableVideo[];
        pagination: {
          page: number;
          limit: number;
          total: number;
          totalPages: number;
        };
      };
    }

    const conditions = [eq(videosTable.isAvailable, false)];
    if (directoryId !== undefined) {
      conditions.push(eq(videosTable.directoryId, directoryId));
    }
    const whereClause = and(...conditions);

    const [countRow] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(videosTable)
      .where(whereClause);
    const total = countRow?.total ?? 0;

    const rows = await db
      .select({
        id: videosTable.id,
        filePath: videosTable.filePath,
        fileName: videosTable.fileName,
        directoryId: videosTable.directoryId,
        directoryPath: watchedDirectoriesTable.path,
        fileSizeBytes: videosTable.fileSizeBytes,
        lastVerifiedAt: videosTable.lastVerifiedAt,
        updatedAt: videosTable.updatedAt,
      })
      .from(videosTable)
      .leftJoin(
        watchedDirectoriesTable,
        eq(videosTable.directoryId, watchedDirectoriesTable.id)
      )
      .where(whereClause)
      .orderBy(desc(videosTable.updatedAt))
      .limit(limit)
      .offset(offset);

    const ids = rows.map((row) => row.id);

    // Per-video artifact summaries (empty maps when there are no rows)
    const thumbnailMap = new Map<number, { id: number; bytes: number }>();
    const storyboardMap = new Map<number, number>();
    const faceMap = new Map<number, { count: number; bytes: number }>();
    const artworkMap = new Map<number, { count: number; bytes: number }>();

    if (ids.length > 0) {
      const [thumbnails, storyboards, faces, artwork] = await Promise.all([
        db
          .select({
            id: thumbnailsTable.id,
            videoId: thumbnailsTable.videoId,
            bytes: thumbnailsTable.fileSizeBytes,
          })
          .from(thumbnailsTable)
          .where(inArray(thumbnailsTable.videoId, ids)),
        db
          .select({
            videoId: storyboardsTable.videoId,
            bytes: storyboardsTable.spriteSizeBytes,
          })
          .from(storyboardsTable)
          .where(inArray(storyboardsTable.videoId, ids)),
        db
          .select({
            videoId: videoFaceDetectionsTable.videoId,
            count: sql<number>`count(${faceImagesTable.id})::int`,
            bytes: sql<number>`coalesce(sum(${faceImagesTable.fileSizeBytes}), 0)::int`,
          })
          .from(faceImagesTable)
          .innerJoin(
            videoFaceDetectionsTable,
            eq(faceImagesTable.detectionId, videoFaceDetectionsTable.id)
          )
          .where(inArray(videoFaceDetectionsTable.videoId, ids))
          .groupBy(videoFaceDetectionsTable.videoId),
        db
          .select({
            videoId: artworkAssetsTable.videoId,
            count: sql<number>`count(${artworkAssetsTable.id})::int`,
            bytes: sql<number>`coalesce(sum(${artworkAssetsTable.fileSizeBytes}), 0)::int`,
          })
          .from(artworkAssetsTable)
          .where(inArray(artworkAssetsTable.videoId, ids))
          .groupBy(artworkAssetsTable.videoId),
      ]);

      for (const thumbnail of thumbnails) {
        thumbnailMap.set(thumbnail.videoId, {
          id: thumbnail.id,
          bytes: thumbnail.bytes ?? 0,
        });
      }
      for (const storyboard of storyboards) {
        storyboardMap.set(storyboard.videoId, storyboard.bytes ?? 0);
      }
      for (const face of faces) {
        faceMap.set(face.videoId, { count: face.count, bytes: face.bytes });
      }
      for (const asset of artwork) {
        artworkMap.set(asset.videoId, {
          count: asset.count,
          bytes: asset.bytes,
        });
      }
    }

    const data: UnavailableVideo[] = rows.map((row) => {
      const thumbnail = thumbnailMap.get(row.id);
      const hasThumbnail = thumbnail !== undefined;
      const hasStoryboard = storyboardMap.has(row.id);
      const faceSummary = faceMap.get(row.id);
      const artworkSummary = artworkMap.get(row.id);
      const reclaimableBytes =
        (thumbnail?.bytes ?? 0) +
        (storyboardMap.get(row.id) ?? 0) +
        (faceSummary?.bytes ?? 0) +
        (artworkSummary?.bytes ?? 0);

      return {
        id: row.id,
        file_path: row.filePath,
        file_name: row.fileName,
        directory_id: row.directoryId,
        directory_path: row.directoryPath ?? null,
        last_verified_at: row.lastVerifiedAt?.toISOString() ?? null,
        thumbnail_url: thumbnail
          ? `${API_PREFIX}/thumbnails/${thumbnail.id}/image`
          : null,
        artifacts: {
          thumbnail: hasThumbnail,
          storyboard: hasStoryboard,
          face_count: faceSummary?.count ?? 0,
          artwork_count: artworkSummary?.count ?? 0,
          reclaimable_bytes: reclaimableBytes,
        },
      };
    });

    return {
      data,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Fully purge unavailable videos: deletes the database record plus all derived
   * artifacts (thumbnails, storyboards, extracted face images, and the cascaded
   * detection/stats/link rows).
   *
   * Only videos that are actually marked unavailable are purged — passing the id
   * of an available video is a no-op, so the endpoint can never delete a video
   * whose file is still present.
   */
  async purgeUnavailable(input: {
    ids?: number[];
    directoryId?: number;
  }): Promise<{ deleted_count: number; deleted_ids: number[] }> {
    if (env.DEMO_MODE) {
      return videosDemoService.purgeUnavailable(input);
    }

    const conditions = [eq(videosTable.isAvailable, false)];
    if (input.ids && input.ids.length > 0) {
      conditions.push(inArray(videosTable.id, input.ids));
    }
    if (input.directoryId !== undefined) {
      conditions.push(eq(videosTable.directoryId, input.directoryId));
    }

    const targets = await db
      .select({ id: videosTable.id })
      .from(videosTable)
      .where(and(...conditions));

    const ids = targets.map((target) => target.id);
    if (ids.length === 0) {
      return { deleted_count: 0, deleted_ids: [] };
    }

    await videosBulkService.bulkDelete(ids);

    logger.info({ deletedCount: ids.length }, "Purged unavailable videos");
    return { deleted_count: ids.length, deleted_ids: ids };
  }

  /**
   * Re-verify the on-disk availability of videos (optionally scoped to a
   * directory). Useful before purging so files that have returned are no longer
   * counted as unavailable.
   */
  async verifyAvailabilityBulk(options: { directoryId?: number }): Promise<{
    checked: number;
    now_available: number;
    still_missing: number;
  }> {
    if (env.DEMO_MODE) {
      return videosDemoService.verifyAvailability({
        directoryId: options.directoryId,
      });
    }

    const conditions =
      options.directoryId !== undefined
        ? [eq(videosTable.directoryId, options.directoryId)]
        : [];

    const videos = await db
      .select({ id: videosTable.id, filePath: videosTable.filePath })
      .from(videosTable)
      .where(conditions.length > 0 ? and(...conditions) : undefined);

    const fs = await import("fs");
    const now = new Date();
    let nowAvailable = 0;
    let stillMissing = 0;

    for (const video of videos) {
      const exists = fs.existsSync(video.filePath);
      if (exists) {
        nowAvailable++;
      } else {
        stillMissing++;
      }
      await db
        .update(videosTable)
        .set({ isAvailable: exists, lastVerifiedAt: now })
        .where(eq(videosTable.id, video.id));
    }

    return {
      checked: videos.length,
      now_available: nowAvailable,
      still_missing: stillMissing,
    };
  }

  /**
   * Re-read video metadata from disk and regenerate its thumbnail.
   * Useful when a file was indexed before a download completed.
   */
  async refreshDerivedData(id: number, userId?: number): Promise<Video> {
    if (env.DEMO_MODE) {
      await demoMediaAssetsService.refreshVideo(id);
      return demoRepository.getVideoById(id) as Video;
    }

    const video = await this.findById(id, userId);

    if (!existsSync(video.file_path)) {
      await db
        .update(videosTable)
        .set({
          isAvailable: false,
          lastVerifiedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(videosTable.id, id));

      throw new BadRequestError("Video file not found on disk");
    }

    const fileStats = statSync(video.file_path);
    const [fileHash, metadata] = await Promise.all([
      computeFileHash(video.file_path),
      metadataService.extractMetadata(video.file_path),
    ]);

    await db
      .update(videosTable)
      .set({
        fileSizeBytes: fileStats.size,
        fileHash,
        durationSeconds: metadata.duration_seconds,
        width: metadata.width,
        height: metadata.height,
        codec: metadata.codec,
        bitrate: metadata.bitrate,
        fps: metadata.fps,
        audioCodec: metadata.audio_codec,
        isAvailable: true,
        lastVerifiedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(videosTable.id, id));

    await thumbnailsService.generate(id);

    logger.info({ videoId: id }, "Video metadata and thumbnail refreshed");

    return this.findById(id, userId);
  }

  /**
   * Get studios associated with a video
   */
  async getStudios(videoId: number) {
    if (env.DEMO_MODE) {
      const video = await this.findById(videoId);
      return video.studios || [];
    }

    await this.findById(videoId); // Ensure video exists

    const studios = await db
      .select({
        id: studiosTable.id,
        name: studiosTable.name,
        description: studiosTable.description,
        profilePicturePath: studiosTable.profilePicturePath,
        createdAt: studiosTable.createdAt,
        updatedAt: studiosTable.updatedAt,
      })
      .from(studiosTable)
      .innerJoin(
        videoStudiosTable,
        eq(studiosTable.id, videoStudiosTable.studioId)
      )
      .where(eq(videoStudiosTable.videoId, videoId))
      .orderBy(studiosTable.name);

    return studios.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      profile_picture_path: s.profilePicturePath,
      created_at: s.createdAt.toISOString(),
      updated_at: s.updatedAt.toISOString(),
    }));
  }

  /**
   * Replace a video's file in-place, preserving the record and all relations.
   * Updates file path, size, hash, and all technical metadata from the new file.
   */
  async replaceFile(videoId: number, newFilePath: string): Promise<Video> {
    if (env.DEMO_MODE) {
      await demoMediaAssetsService.replaceVideoFile(videoId, newFilePath);
      return demoRepository.getVideoById(videoId) as Video;
    }

    await this.findById(videoId);

    const fileStats = statSync(newFilePath);
    const [fileHash, metadata] = await Promise.all([
      computeFileHash(newFilePath),
      metadataService.extractMetadata(newFilePath),
    ]);

    const fileName = basename(newFilePath);

    await db
      .update(videosTable)
      .set({
        filePath: newFilePath,
        fileName,
        fileSizeBytes: fileStats.size,
        fileHash,
        codec: metadata.codec,
        bitrate: metadata.bitrate,
        width: metadata.width,
        height: metadata.height,
        fps: metadata.fps,
        audioCodec: metadata.audio_codec,
        durationSeconds: metadata.duration_seconds,
        updatedAt: new Date(),
      })
      .where(eq(videosTable.id, videoId));

    logger.info(
      { videoId, newFilePath, newSize: fileStats.size },
      "Video file replaced in-place"
    );

    return this.findById(videoId);
  }

  /**
   * Register a newly-created local video without waiting for the next directory
   * scan. Callers retain ownership of the physical file if registration fails.
   */
  async registerLocalFile(
    filePath: string,
    directoryId: number,
    options: { generateThumbnail?: boolean } = {}
  ): Promise<Video> {
    if (env.DEMO_MODE) {
      throw new BadRequestError(
        "Local file registration is unavailable in demo mode"
      );
    }
    if (!existsSync(filePath)) {
      throw new BadRequestError("Video file not found on disk");
    }

    const fileStats = statSync(filePath);
    if (!fileStats.isFile()) {
      throw new BadRequestError("Video path is not a regular file");
    }
    const [fileHash, metadata] = await Promise.all([
      computeFileHash(filePath),
      metadataService.extractMetadata(filePath),
    ]);

    try {
      const [inserted] = await db
        .insert(videosTable)
        .values({
          filePath,
          fileName: basename(filePath),
          directoryId,
          fileSizeBytes: fileStats.size,
          fileHash,
          durationSeconds: metadata.duration_seconds,
          width: metadata.width,
          height: metadata.height,
          codec: metadata.codec,
          bitrate: metadata.bitrate,
          fps: metadata.fps,
          audioCodec: metadata.audio_codec,
          isAvailable: true,
          lastVerifiedAt: new Date(),
        })
        .returning({ id: videosTable.id });
      if (!inserted) throw new Error("Failed to register rendered video");

      if (options.generateThumbnail !== false) {
        thumbnailsService.generate(inserted.id).catch((error) => {
          logger.warn(
            { error, videoId: inserted.id },
            "Failed to generate thumbnail for rendered video"
          );
        });
      }
      logger.info(
        { videoId: inserted.id, filePath },
        "Rendered video registered"
      );
      return this.findById(inserted.id);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError("Video file path is already registered");
      }
      throw error;
    }
  }

  /** Remove only a catalog row, used to roll back an interrupted publication. */
  async removeCatalogRecord(
    videoId: number,
    expectedFilePath: string
  ): Promise<boolean> {
    if (env.DEMO_MODE) return false;
    await videosBulkService.assertNoActiveEditJobs([videoId]);
    const [deleted] = await db
      .delete(videosTable)
      .where(
        and(
          eq(videosTable.id, videoId),
          eq(videosTable.filePath, expectedFilePath)
        )
      )
      .returning({ id: videosTable.id });
    if (deleted) {
      logger.info(
        { videoId, filePath: expectedFilePath },
        "Rolled back rendered video catalog entry"
      );
    }
    return Boolean(deleted);
  }
}

export const videosService = new VideosService();
