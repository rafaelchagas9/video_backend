import { eq, sql, and } from "drizzle-orm";
import { db } from "@/config/drizzle";
import {
  studiosTable,
  creatorStudiosTable,
  videoStudiosTable,
} from "@/database/schema";
import {
  NotFoundError,
  ConflictError,
  isUniqueViolation,
  isForeignKeyViolation,
} from "@/utils/errors";
import { API_PREFIX } from "@/config/constants";
import type { Studio } from "./studios.types";
import type { Creator } from "@/modules/creators/creators.types";
import type { Video } from "@/modules/videos/videos.types";
import { env } from "@/config/env";
import { demoRepository } from "@/database/demo";
import { studiosDemoService } from "./studios.demo.service";

export class StudiosRelationshipsService {
  // Creator Relationship Methods
  async linkCreator(studioId: number, creatorId: number): Promise<void> {
    if (env.DEMO_MODE) {
      studiosDemoService.linkCreator(studioId, creatorId);
      return;
    }
    await this.findStudioById(studioId); // Ensure studio exists

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
        // PostgreSQL UNIQUE violation
        throw new ConflictError("Creator is already linked to this studio");
      }
      if (isForeignKeyViolation(error)) {
        // PostgreSQL FOREIGN KEY violation
        throw new NotFoundError(`Creator not found with id: ${creatorId}`);
      }
      throw error;
    }
  }

  async unlinkCreator(studioId: number, creatorId: number): Promise<void> {
    if (env.DEMO_MODE) {
      studiosDemoService.unlinkCreator(studioId, creatorId);
      return;
    }
    await db
      .delete(creatorStudiosTable)
      .where(
        sql`${creatorStudiosTable.creatorId} = ${creatorId} AND ${creatorStudiosTable.studioId} = ${studioId}`
      );

    // Note: Drizzle postgres-js doesn't return rowCount, so we can't verify if deletion happened
    // The delete will silently succeed even if no rows match
  }

  async getCreators(studioId: number): Promise<Creator[]> {
    if (env.DEMO_MODE) return studiosDemoService.getCreators(studioId);
    await this.findStudioById(studioId); // Ensure studio exists

    const creators = await db.execute<{
      id: number;
      name: string;
      description: string | null;
      profile_picture_path: string | null;
      face_thumbnail_path: string | null;
      created_at: Date;
      updated_at: Date;
    }>(sql`
      SELECT
        c.*,
        profile_media.file_path as unified_profile_picture_path,
        main_media.file_path as unified_main_picture_path
      FROM creators c
      LEFT JOIN LATERAL (
        SELECT file_path FROM creator_gallery_media
        WHERE creator_id = c.id AND is_profile_picture = true
        ORDER BY updated_at DESC, id DESC
        LIMIT 1
      ) profile_media ON true
      LEFT JOIN LATERAL (
        SELECT file_path FROM creator_gallery_media
        WHERE creator_id = c.id AND is_main_picture = true
        ORDER BY updated_at DESC, id DESC
        LIMIT 1
      ) main_media ON true
      INNER JOIN creator_studios cs ON c.id = cs.creator_id
      WHERE cs.studio_id = ${studioId}
      ORDER BY c.name ASC
    `);

    const results = Array.isArray(creators) ? creators : [];
    return results.map((c: any) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      profile_picture_path:
        c.unified_profile_picture_path ?? c.profile_picture_path,
      main_picture_path:
        c.unified_main_picture_path ?? c.main_picture_path ?? null,
      face_thumbnail_path: c.face_thumbnail_path,
      profile_picture_url:
        (c.unified_profile_picture_path ?? c.profile_picture_path)
          ? `/api/creators/${c.id}/picture`
          : undefined,
      main_picture_url:
        (c.unified_main_picture_path ?? c.main_picture_path)
          ? `/api/creators/${c.id}/picture?variant=main`
          : undefined,
      face_thumbnail_url: c.face_thumbnail_path
        ? `/api/creators/${c.id}/picture?type=face`
        : undefined,
      is_favorite: false,
      created_at: new Date(c.created_at).toISOString(),
      updated_at: new Date(c.updated_at).toISOString(),
    }));
  }

  // Video Relationship Methods
  async linkVideo(studioId: number, videoId: number): Promise<void> {
    if (env.DEMO_MODE) {
      studiosDemoService.linkVideo(studioId, videoId);
      return;
    }
    await this.findStudioById(studioId); // Ensure studio exists

    // Check if association already exists
    const existing = await db
      .select()
      .from(videoStudiosTable)
      .where(
        and(
          eq(videoStudiosTable.videoId, videoId),
          eq(videoStudiosTable.studioId, studioId)
        )
      )
      .limit(1);

    if (existing && existing.length > 0) {
      throw new ConflictError("Video is already linked to this studio");
    }

    try {
      await db.insert(videoStudiosTable).values({
        videoId,
        studioId,
      });
    } catch (error: any) {
      if (isUniqueViolation(error)) {
        // PostgreSQL UNIQUE violation
        throw new ConflictError("Video is already linked to this studio");
      }
      if (isForeignKeyViolation(error)) {
        // PostgreSQL FOREIGN KEY violation
        throw new NotFoundError(`Video not found with id: ${videoId}`);
      }
      throw error;
    }
  }

  async unlinkVideo(studioId: number, videoId: number): Promise<void> {
    if (env.DEMO_MODE) {
      studiosDemoService.unlinkVideo(studioId, videoId);
      return;
    }
    await db
      .delete(videoStudiosTable)
      .where(
        sql`${videoStudiosTable.videoId} = ${videoId} AND ${videoStudiosTable.studioId} = ${studioId}`
      );

    // Note: Drizzle postgres-js doesn't return rowCount, so we can't verify if deletion happened
    // The delete will silently succeed even if no rows match
  }

  async getVideos(studioId: number): Promise<Video[]> {
    if (env.DEMO_MODE)
      return studiosDemoService
        .getVideoIds(studioId)
        .map((id) => demoRepository.getVideoById(id) as Video);
    await this.findStudioById(studioId); // Ensure studio exists

    const videos = await db.execute<any>(sql`
      SELECT v.*, t.id as thumbnail_id
      FROM videos v
      INNER JOIN video_studios vs ON v.id = vs.video_id
      LEFT JOIN (
        SELECT DISTINCT ON (video_id) id, video_id FROM thumbnails
      ) t ON v.id = t.video_id
      WHERE vs.studio_id = ${studioId}
      ORDER BY v.created_at DESC
    `);

    const results = Array.isArray(videos) ? videos : [];
    return results.map((v: any) => ({
      ...v,
      thumbnail_url: v.thumbnail_id
        ? `${API_PREFIX}/thumbnails/${v.thumbnail_id}/image`
        : null,
    }));
  }

  async getStudiosForVideo(videoId: number): Promise<Studio[]> {
    const studios = await db.execute<{
      id: number;
      name: string;
      description: string | null;
      profile_picture_path: string | null;
      created_at: Date;
      updated_at: Date;
    }>(sql`
      SELECT s.* FROM studios s
      INNER JOIN video_studios vs ON s.id = vs.studio_id
      WHERE vs.video_id = ${videoId}
      ORDER BY s.name ASC
    `);

    const results = Array.isArray(studios) ? studios : [];
    return results.map((s: any) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      profile_picture_path: s.profile_picture_path,
      created_at: new Date(s.created_at).toISOString(),
      updated_at: new Date(s.updated_at).toISOString(),
    }));
  }

  async getStudiosForVideos(
    videoIds: number[]
  ): Promise<Map<number, Studio[]>> {
    const grouped = new Map<number, Studio[]>();
    if (videoIds.length === 0) {
      return grouped;
    }

    const rows = await db.execute<{
      video_id: number;
      id: number;
      name: string;
      description: string | null;
      profile_picture_path: string | null;
      created_at: Date;
      updated_at: Date;
    }>(sql`
      SELECT
        vs.video_id,
        s.id,
        s.name,
        s.description,
        s.profile_picture_path,
        s.created_at,
        s.updated_at
      FROM studios s
      INNER JOIN video_studios vs ON s.id = vs.studio_id
      WHERE vs.video_id = ANY(${sql.raw(`ARRAY[${videoIds.join(",")}]::int[]`)})
      ORDER BY vs.video_id ASC, s.name ASC
    `);

    const results = Array.isArray(rows) ? rows : [];
    for (const row of results) {
      const studio: Studio = {
        id: row.id,
        name: row.name,
        description: row.description,
        profile_picture_path: row.profile_picture_path,
        created_at: new Date(row.created_at).toISOString(),
        updated_at: new Date(row.updated_at).toISOString(),
      };
      const existing = grouped.get(Number(row.video_id)) ?? [];
      existing.push(studio);
      grouped.set(Number(row.video_id), existing);
    }

    return grouped;
  }

  // Bulk Update Creators
  async bulkUpdateCreators(
    studioId: number,
    input: { creatorIds: number[]; action: "add" | "remove" }
  ): Promise<void> {
    if (env.DEMO_MODE) {
      studiosDemoService.bulkUpdateCreators(studioId, input);
      return;
    }
    const { creatorIds, action } = input;
    if (creatorIds.length === 0) return;

    await this.findStudioById(studioId); // Ensure studio exists

    if (action === "add") {
      // Insert all creator links, ignore conflicts (already linked)
      for (const creatorId of creatorIds) {
        try {
          await db.insert(creatorStudiosTable).values({
            creatorId,
            studioId,
          });
        } catch (error: any) {
          // Ignore unique constraint violations (already linked)
          if (!isUniqueViolation(error)) {
            throw error;
          }
        }
      }
    } else {
      // Remove all creator links
      await db.delete(creatorStudiosTable).where(
        sql`${creatorStudiosTable.studioId} = ${studioId} AND ${creatorStudiosTable.creatorId} IN (${sql.join(
          creatorIds.map((id) => sql`${id}`),
          sql`, `
        )})`
      );
    }
  }

  // Helper methods
  private async findStudioById(id: number): Promise<Studio> {
    const studio = await db
      .select()
      .from(studiosTable)
      .where(eq(studiosTable.id, id))
      .limit(1)
      .then((rows) => rows[0] || null);

    if (!studio) {
      throw new NotFoundError(`Studio not found with id: ${id}`);
    }

    return {
      id: studio.id,
      name: studio.name,
      description: studio.description,
      profile_picture_path: studio.profilePicturePath,
      created_at: studio.createdAt.toISOString(),
      updated_at: studio.updatedAt.toISOString(),
    };
  }
}

export const studiosRelationshipsService = new StudiosRelationshipsService();
