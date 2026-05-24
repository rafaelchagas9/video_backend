import { eq, sql, and } from "drizzle-orm";
import { db } from "@/config/drizzle";
import {
  videosTable,
  studiosTable,
  videoStudiosTable,
  conversionJobsTable,
  thumbnailsTable,
  favoritesTable,
} from "@/database/schema";
import { BadRequestError, NotFoundError } from "@/utils/errors";
import { API_PREFIX } from "@/config/constants";
import { logger } from "@/utils/logger";
import { existsSync, unlinkSync, statSync } from "fs";
import { basename } from "path";
import type { Video, UpdateVideoInput } from "./videos.types";
import { computeFileHash } from "@/utils/file-utils";
import { metadataService } from "./metadata.service";
import { thumbnailsService } from "@/modules/thumbnails/thumbnails.service";
import { conversionService } from "@/modules/conversion/conversion.service";
import { videoCollectionsService } from "@/modules/video-collections/video-collections.service";
import { creatorsRelationshipsService } from "@/modules/creators/creators.relationships.service";
import { tagsService } from "@/modules/tags/tags.service";
import { studiosRelationshipsService } from "@/modules/studios/studios.relationships.service";

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

    if (include.includes("collection")) {
      response.collection =
        await videoCollectionsService.getCollectionContextByVideoId(id);
    }

    if (include.includes("collection_neighbors")) {
      response.collection_neighbors =
        await videoCollectionsService.getNeighborsByVideoId(id);
    }

    if (include.includes("creators")) {
      response.creators =
        await creatorsRelationshipsService.getCreatorsForVideo(id);
    }

    if (include.includes("tags")) {
      response.tags = await tagsService.getTagsForVideo(id);
    }

    if (include.includes("studios")) {
      response.studios =
        await studiosRelationshipsService.getStudiosForVideo(id);
    }

    return response;
  }

  /**
   * Get random video
   */
  async getRandomVideo(userId: number): Promise<Video> {
    const randomVideo = await db
      .select({ id: videosTable.id })
      .from(videosTable)
      .where(eq(videosTable.isAvailable, true))
      .orderBy(sql`RANDOM()`)
      .limit(1);

    if (!randomVideo || randomVideo.length === 0) {
      throw new NotFoundError("No available videos found");
    }

    return this.findById(randomVideo[0].id, userId);
  }

  /**
   * Update video
   */
  async update(id: number, input: UpdateVideoInput): Promise<Video> {
    await this.findById(id); // Ensure exists

    const updateData: Partial<typeof videosTable.$inferInsert> = {};

    if (input.title !== undefined) updateData.title = input.title;
    if (input.description !== undefined)
      updateData.description = input.description;
    if (input.themes !== undefined) updateData.themes = input.themes;

    if (Object.keys(updateData).length === 0) {
      return this.findById(id);
    }

    updateData.updatedAt = new Date();

    await db.update(videosTable).set(updateData).where(eq(videosTable.id, id));

    return this.findById(id);
  }

  /**
   * Delete video (including file and related data)
   */
  async delete(id: number): Promise<void> {
    const video = await this.findById(id); // Ensure exists

    // Delete all thumbnails (both file and DB)
    const thumbnails = await thumbnailsService.getByVideoId(id);
    for (const thumbnail of thumbnails) {
      try {
        await thumbnailsService.delete(thumbnail.id);
      } catch (error) {
        logger.warn(
          { error, thumbnailId: thumbnail.id },
          "Failed to delete thumbnail",
        );
      }
    }

    // Delete conversion DB records (keep converted files - they're valuable outputs)
    const conversions = await conversionService.listByVideoId(id);
    for (const conversion of conversions) {
      try {
        await db
          .delete(conversionJobsTable)
          .where(eq(conversionJobsTable.id, conversion.id));
      } catch (error) {
        logger.warn(
          { error, conversionId: conversion.id },
          "Failed to delete conversion record",
        );
      }
    }

    // Delete the video file itself
    if (video.file_path) {
      try {
        if (existsSync(video.file_path)) {
          unlinkSync(video.file_path);
        }
      } catch (error) {
        logger.warn(
          { error, path: video.file_path },
          "Failed to delete video file",
        );
        // Continue with database deletion even if file deletion fails
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

    await db
      .update(videosTable)
      .set({
        isAvailable: exists,
        lastVerifiedAt: new Date(),
      })
      .where(eq(videosTable.id, id));

    return this.findById(id);
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
