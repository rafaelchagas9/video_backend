import { eq, and, inArray, sql } from "drizzle-orm";
import { db } from "@/config/drizzle";
import {
  videoCreatorsTable,
  creatorStudiosTable,
  creatorsTable,
  videosTable,
  studiosTable,
  videoStudiosTable,
} from "@/database/schema";
import {
  NotFoundError,
  ConflictError,
  isUniqueViolation,
  isForeignKeyViolation,
} from "@/utils/errors";
import { deriveStudioAssignmentStatus, type Video } from "@/modules/videos/videos.types";
import type { Creator } from "./creators.types";
import type { Studio } from "@/modules/studios/studios.types";
import { env } from "@/config/env";
import { demoRepository } from "@/database/demo";
import { creatorsDemoService } from "./creators.demo.service";
import { videosDemoService } from "@/modules/videos/videos.demo.service";

export class CreatorsRelationshipsService {
  // Video Relationship Methods
  async getVideos(creatorId: number): Promise<Video[]> {
    if (env.DEMO_MODE)
      return demoRepository.getVideos({
        creatorIds: [creatorId],
        limit: 10_000,
      }).data as Video[];
    // Verify creator exists
    await this.verifyCreatorExists(creatorId);

    const videos = await db
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
      })
      .from(videosTable)
      .innerJoin(
        videoCreatorsTable,
        eq(videosTable.id, videoCreatorsTable.videoId)
      )
      .where(eq(videoCreatorsTable.creatorId, creatorId))
      .orderBy(videosTable.createdAt);

    return videos.map(this.mapVideoToSnakeCase);
  }

  async addToVideo(videoId: number, creatorId: number): Promise<void> {
    if (env.DEMO_MODE) {
      videosDemoService.updateRelationships(
        [videoId],
        "creators",
        [creatorId],
        "add"
      );
      return;
    }
    // Verify creator exists
    await this.verifyCreatorExists(creatorId);

    // Check if association already exists
    const existing = await db
      .select()
      .from(videoCreatorsTable)
      .where(
        and(
          eq(videoCreatorsTable.videoId, videoId),
          eq(videoCreatorsTable.creatorId, creatorId)
        )
      )
      .limit(1);

    if (existing && existing.length > 0) {
      throw new ConflictError("Creator is already associated with this video");
    }

    try {
      await db.insert(videoCreatorsTable).values({
        videoId,
        creatorId,
      });
    } catch (error: any) {
      if (isUniqueViolation(error)) {
        throw new ConflictError(
          "Creator is already associated with this video"
        );
      }
      if (isForeignKeyViolation(error)) {
        // FOREIGN KEY violation
        throw new NotFoundError(`Video not found with id: ${videoId}`);
      }
      throw error;
    }
  }

  async removeFromVideo(videoId: number, creatorId: number): Promise<void> {
    if (env.DEMO_MODE) {
      videosDemoService.updateRelationships(
        [videoId],
        "creators",
        [creatorId],
        "remove"
      );
      return;
    }
    await db
      .delete(videoCreatorsTable)
      .where(
        and(
          eq(videoCreatorsTable.videoId, videoId),
          eq(videoCreatorsTable.creatorId, creatorId)
        )
      );

    // Drizzle returns an array, not an object with rowCount
    // We skip the check as the delete will succeed even if no rows match
  }

  async getCreatorsForVideo(videoId: number): Promise<Creator[]> {
    if (env.DEMO_MODE) {
      const { demoMockService } = await import("@/utils/demo-mock");
      return demoMockService.getVideoById(videoId).creators as Creator[];
    }

    const creators = await db
      .select({
        id: creatorsTable.id,
        name: creatorsTable.name,
        description: creatorsTable.description,
        profilePicturePath: sql<string | null>`(
          SELECT file_path FROM creator_gallery_media
          WHERE creator_id = ${creatorsTable.id} AND is_profile_picture = true
          ORDER BY updated_at DESC, id DESC
          LIMIT 1
        )`.as("profilePicturePath"),
        mainPicturePath: sql<string | null>`(
          SELECT file_path FROM creator_gallery_media
          WHERE creator_id = ${creatorsTable.id} AND is_main_picture = true
          ORDER BY updated_at DESC, id DESC
          LIMIT 1
        )`.as("mainPicturePath"),
        faceThumbnailPath: creatorsTable.faceThumbnailPath,
        createdAt: creatorsTable.createdAt,
        updatedAt: creatorsTable.updatedAt,
      })
      .from(creatorsTable)
      .innerJoin(
        videoCreatorsTable,
        eq(creatorsTable.id, videoCreatorsTable.creatorId)
      )
      .where(eq(videoCreatorsTable.videoId, videoId))
      .orderBy(creatorsTable.name);

    return creators.map(this.mapCreatorToSnakeCase);
  }

  async getCreatorsForVideos(
    videoIds: number[]
  ): Promise<Map<number, Creator[]>> {
    const grouped = new Map<number, Creator[]>();
    if (env.DEMO_MODE) {
      const { demoMockService } = await import("@/utils/demo-mock");
      for (const videoId of videoIds) {
        try {
          grouped.set(
            videoId,
            demoMockService.getVideoById(videoId).creators as Creator[]
          );
        } catch {
          // Missing demo videos simply do not contribute a relationship.
        }
      }
      return grouped;
    }

    if (videoIds.length === 0) {
      return grouped;
    }

    const rows = await db
      .select({
        videoId: videoCreatorsTable.videoId,
        id: creatorsTable.id,
        name: creatorsTable.name,
        description: creatorsTable.description,
        profilePicturePath: sql<string | null>`(
          SELECT file_path FROM creator_gallery_media
          WHERE creator_id = ${creatorsTable.id} AND is_profile_picture = true
          ORDER BY updated_at DESC, id DESC
          LIMIT 1
        )`.as("profilePicturePath"),
        mainPicturePath: sql<string | null>`(
          SELECT file_path FROM creator_gallery_media
          WHERE creator_id = ${creatorsTable.id} AND is_main_picture = true
          ORDER BY updated_at DESC, id DESC
          LIMIT 1
        )`.as("mainPicturePath"),
        faceThumbnailPath: creatorsTable.faceThumbnailPath,
        createdAt: creatorsTable.createdAt,
        updatedAt: creatorsTable.updatedAt,
      })
      .from(videoCreatorsTable)
      .innerJoin(
        creatorsTable,
        eq(creatorsTable.id, videoCreatorsTable.creatorId)
      )
      .where(inArray(videoCreatorsTable.videoId, videoIds))
      .orderBy(videoCreatorsTable.videoId, creatorsTable.name);

    for (const row of rows) {
      const creator = this.mapCreatorToSnakeCase(row);
      const existing = grouped.get(row.videoId) ?? [];
      existing.push(creator);
      grouped.set(row.videoId, existing);
    }

    return grouped;
  }

  // Studio Relationship Methods
  async linkStudio(creatorId: number, studioId: number): Promise<void> {
    if (env.DEMO_MODE) {
      creatorsDemoService.linkStudio(creatorId, studioId);
      return;
    }
    // Verify creator exists
    await this.verifyCreatorExists(creatorId);

    // Check if association already exists
    const existing = await db
      .select()
      .from(creatorStudiosTable)
      .where(
        and(
          eq(creatorStudiosTable.creatorId, creatorId),
          eq(creatorStudiosTable.studioId, studioId)
        )
      )
      .limit(1);

    if (existing && existing.length > 0) {
      throw new ConflictError("Creator is already linked to this studio");
    }

    try {
      await db.insert(creatorStudiosTable).values({
        creatorId,
        studioId,
      });
    } catch (error: any) {
      if (isUniqueViolation(error)) {
        throw new ConflictError("Creator is already linked to this studio");
      }
      if (isForeignKeyViolation(error)) {
        throw new NotFoundError(`Studio not found with id: ${studioId}`);
      }
      throw error;
    }
  }

  async unlinkStudio(creatorId: number, studioId: number): Promise<void> {
    if (env.DEMO_MODE) {
      creatorsDemoService.unlinkStudio(creatorId, studioId);
      return;
    }
    await db
      .delete(creatorStudiosTable)
      .where(
        and(
          eq(creatorStudiosTable.creatorId, creatorId),
          eq(creatorStudiosTable.studioId, studioId)
        )
      );
  }

  async getStudios(creatorId: number): Promise<Studio[]> {
    if (env.DEMO_MODE)
      return creatorsDemoService
        .getStudioIds(creatorId)
        .map((id) => demoRepository.getStudioById(id) as Studio);
    // Verify creator exists
    await this.verifyCreatorExists(creatorId);

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
        creatorStudiosTable,
        eq(studiosTable.id, creatorStudiosTable.studioId)
      )
      .where(eq(creatorStudiosTable.creatorId, creatorId))
      .orderBy(studiosTable.name);

    return studios.map(this.mapStudioToSnakeCase);
  }

  private async verifyCreatorExists(creatorId: number): Promise<void> {
    const result = await db
      .select({ id: creatorsTable.id })
      .from(creatorsTable)
      .where(eq(creatorsTable.id, creatorId))
      .limit(1);

    if (!result || result.length === 0) {
      throw new NotFoundError(`Creator not found with id: ${creatorId}`);
    }
  }

  private mapVideoToSnakeCase(video: any): Video {
    return {
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
      last_verified_at:
        video.lastVerifiedAt instanceof Date
          ? video.lastVerifiedAt.toISOString()
          : video.lastVerifiedAt,
      indexed_at:
        video.indexedAt instanceof Date
          ? video.indexedAt.toISOString()
          : video.indexedAt,
      created_at:
        video.createdAt instanceof Date
          ? video.createdAt.toISOString()
          : video.createdAt,
      updated_at:
        video.updatedAt instanceof Date
          ? video.updatedAt.toISOString()
          : video.updatedAt,
      is_favorite: false, // Not queried, default to false
    };
  }

  private mapCreatorToSnakeCase(creator: any): Creator {
    return {
      id: creator.id,
      name: creator.name,
      description: creator.description,
      profile_picture_path: creator.profilePicturePath,
      main_picture_path: creator.mainPicturePath ?? null,
      face_thumbnail_path: creator.faceThumbnailPath,
      profile_picture_url:
        (creator.profilePicturePath ?? creator.profile_picture_path)
          ? `/api/creators/${creator.id}/picture`
          : null,
      main_picture_url:
        (creator.mainPicturePath ?? creator.main_picture_path)
          ? `/api/creators/${creator.id}/picture?variant=main`
          : undefined,
      face_thumbnail_url:
        (creator.faceThumbnailPath ?? creator.face_thumbnail_path)
          ? `/api/creators/${creator.id}/picture?type=face`
          : undefined,
      is_favorite: false,
      created_at:
        creator.createdAt instanceof Date
          ? creator.createdAt.toISOString()
          : creator.createdAt,
      updated_at:
        creator.updatedAt instanceof Date
          ? creator.updatedAt.toISOString()
          : creator.updatedAt,
    };
  }

  private mapStudioToSnakeCase(studio: any): Studio {
    return {
      id: studio.id,
      name: studio.name,
      description: studio.description,
      profile_picture_path: studio.profilePicturePath,
      created_at:
        studio.createdAt instanceof Date
          ? studio.createdAt.toISOString()
          : studio.createdAt,
      updated_at:
        studio.updatedAt instanceof Date
          ? studio.updatedAt.toISOString()
          : studio.updatedAt,
    };
  }
}

export const creatorsRelationshipsService = new CreatorsRelationshipsService();
