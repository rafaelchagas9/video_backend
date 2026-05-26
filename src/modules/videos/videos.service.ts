import { eq, sql, and, inArray } from "drizzle-orm";
import { db } from "@/config/drizzle";
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
} from "@/database/schema";
import { BadRequestError, NotFoundError } from "@/utils/errors";
import { API_PREFIX } from "@/config/constants";
import { logger } from "@/utils/logger";
import { existsSync, statSync } from "fs";
import { basename } from "path";
import type {
  RandomVideoOptions,
  Video,
  UpdateVideoInput,
} from "./videos.types";
import { computeFileHash } from "@/utils/file-utils";
import { metadataService } from "./metadata.service";
import { thumbnailsService } from "@/modules/thumbnails/thumbnails.service";
import { videoCollectionsService } from "@/modules/video-collections/video-collections.service";
import { creatorsRelationshipsService } from "@/modules/creators/creators.relationships.service";
import { tagsService } from "@/modules/tags/tags.service";
import { studiosRelationshipsService } from "@/modules/studios/studios.relationships.service";
import { buildVideoFilters } from "./videos.query-builder";

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
    id: number,
  ): Promise<{ file_path: string; is_available: boolean }> {
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

  /**
   * Find video by ID
   */
  async findById(
    id: number,
    userId?: number,
    include: VideoInclude[] = [],
  ): Promise<Video> {
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
          and(
            eq(favoritesTable.userId, userId),
            eq(favoritesTable.videoId, id),
          ),
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
        videoCollectionsService.getCollectionContextByVideoId(id).then((res) => {
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
    options: RandomVideoOptions = {},
  ): Promise<Video | Video[]> {
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

    const limit = resolvedOptions.limit !== undefined ? resolvedOptions.limit : 1;

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
    const video = await this.findById(id); // Ensure exists

    // Query associated thumbnail paths
    const thumbnails = await db
      .select({ filePath: thumbnailsTable.filePath })
      .from(thumbnailsTable)
      .where(eq(thumbnailsTable.videoId, id));

    // Query associated storyboard paths
    const storyboards = await db
      .select({ spritePath: storyboardsTable.spritePath, vttPath: storyboardsTable.vttPath })
      .from(storyboardsTable)
      .where(eq(storyboardsTable.videoId, id));

    const fs = await import("fs");

    // Delete physical files
    for (const thumbnail of thumbnails) {
      if (thumbnail.filePath && fs.existsSync(thumbnail.filePath)) {
        try {
          fs.unlinkSync(thumbnail.filePath);
        } catch (error) {
          logger.warn({ error, path: thumbnail.filePath }, "Failed to delete thumbnail file");
        }
      }
    }

    for (const storyboard of storyboards) {
      if (storyboard.spritePath && fs.existsSync(storyboard.spritePath)) {
        try {
          fs.unlinkSync(storyboard.spritePath);
        } catch (error) {
          logger.warn({ error, path: storyboard.spritePath }, "Failed to delete storyboard sprite");
        }
      }
      if (storyboard.vttPath && fs.existsSync(storyboard.vttPath)) {
        try {
          fs.unlinkSync(storyboard.vttPath);
        } catch (error) {
          logger.warn({ error, path: storyboard.vttPath }, "Failed to delete storyboard VTT");
        }
      }
    }

    if (video.file_path && fs.existsSync(video.file_path)) {
      try {
        fs.unlinkSync(video.file_path);
      } catch (error) {
        logger.warn({ error, path: video.file_path }, "Failed to delete video file");
      }
    }

    // Delete the video database record (CASCADE will handle relationships)
    await db.delete(videosTable).where(eq(videosTable.id, id));
  }

  /**
   * Verify video file availability
   */
  async verifyAvailability(id: number): Promise<Video> {
    const video = await this.findById(id);

    const fs = await import("fs");
    const exists = fs.existsSync(video.file_path);
    const lastVerifiedAt = new Date();

    await db
      .update(videosTable)
      .set({ isAvailable: exists, lastVerifiedAt })
      .where(eq(videosTable.id, id));

    return { ...video, is_available: exists, last_verified_at: lastVerifiedAt.toISOString() };
  }

  /**
   * Re-read video metadata from disk and regenerate its thumbnail.
   * Useful when a file was indexed before a download completed.
   */
  async refreshDerivedData(id: number, userId?: number): Promise<Video> {
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
        eq(studiosTable.id, videoStudiosTable.studioId),
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
      "Video file replaced in-place",
    );

    return this.findById(videoId);
  }
}

export const videosService = new VideosService();
