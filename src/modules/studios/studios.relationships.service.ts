import { eq, sql } from "drizzle-orm";
import { db } from "@/config/drizzle";
import {
  studiosTable,
  creatorStudiosTable,
  videoStudiosTable,
} from "@/database/schema";
import { NotFoundError, ConflictError } from "@/utils/errors";
import { API_PREFIX } from "@/config/constants";
import type { Studio } from "./studios.types";
import type { Creator } from "@/modules/creators/creators.types";
import type { Video } from "@/modules/videos/videos.types";

export class StudiosRelationshipsService {
  // Creator Relationship Methods
  async linkCreator(studioId: number, creatorId: number): Promise<void> {
    await this.findStudioById(studioId); // Ensure studio exists

    try {
      await db.insert(creatorStudiosTable).values({
        creatorId,
        studioId,
      });
    } catch (error: any) {
      if (error.code === "23505") {
        // PostgreSQL UNIQUE violation
        throw new ConflictError("Creator is already linked to this studio");
      }
      if (error.code === "23503") {
        // PostgreSQL FOREIGN KEY violation
        throw new NotFoundError(`Creator not found with id: ${creatorId}`);
      }
      throw error;
    }
  }

  async unlinkCreator(studioId: number, creatorId: number): Promise<void> {
    await db
      .delete(creatorStudiosTable)
      .where(
        sql`${creatorStudiosTable.creatorId} = ${creatorId} AND ${creatorStudiosTable.studioId} = ${studioId}`,
      );

    // Note: Drizzle postgres-js doesn't return rowCount, so we can't verify if deletion happened
    // The delete will silently succeed even if no rows match
  }

  async getCreators(studioId: number): Promise<Creator[]> {
    await this.findStudioById(studioId); // Ensure studio exists

    const creators = await db.execute<{
      id: number;
      name: string;
      description: string | null;
      profile_picture_path: string | null;
      created_at: Date;
      updated_at: Date;
    }>(sql`
      SELECT c.* FROM creators c
      INNER JOIN creator_studios cs ON c.id = cs.creator_id
      WHERE cs.studio_id = ${studioId}
      ORDER BY c.name ASC
    `);

    const results = Array.isArray(creators) ? creators : [];
    return results.map((c: any) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      profile_picture_path: c.profile_picture_path,
      created_at: c.created_at.toISOString(),
      updated_at: c.updated_at.toISOString(),
    }));
  }

  // Video Relationship Methods
  async linkVideo(studioId: number, videoId: number): Promise<void> {
    await this.findStudioById(studioId); // Ensure studio exists

    try {
      await db.insert(videoStudiosTable).values({
        videoId,
        studioId,
      });
    } catch (error: any) {
      if (error.code === "23505") {
        // PostgreSQL UNIQUE violation
        throw new ConflictError("Video is already linked to this studio");
      }
      if (error.code === "23503") {
        // PostgreSQL FOREIGN KEY violation
        throw new NotFoundError(`Video not found with id: ${videoId}`);
      }
      throw error;
    }
  }

  async unlinkVideo(studioId: number, videoId: number): Promise<void> {
    await db
      .delete(videoStudiosTable)
      .where(
        sql`${videoStudiosTable.videoId} = ${videoId} AND ${videoStudiosTable.studioId} = ${studioId}`,
      );

    // Note: Drizzle postgres-js doesn't return rowCount, so we can't verify if deletion happened
    // The delete will silently succeed even if no rows match
  }

  async getVideos(studioId: number): Promise<Video[]> {
    await this.findStudioById(studioId); // Ensure studio exists

    const videos = await db.execute<any>(sql`
      SELECT v.*, t.id as thumbnail_id
      FROM videos v
      INNER JOIN video_studios vs ON v.id = vs.video_id
      LEFT JOIN thumbnails t ON v.id = t.video_id
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
      created_at: s.created_at.toISOString(),
      updated_at: s.updated_at.toISOString(),
    }));
  }

  // Bulk Update Creators
  async bulkUpdateCreators(
    studioId: number,
    input: { creatorIds: number[]; action: "add" | "remove" },
  ): Promise<void> {
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
          if (error.code !== "23505") {
            throw error;
          }
        }
      }
    } else {
      // Remove all creator links
      await db.delete(creatorStudiosTable).where(
        sql`${creatorStudiosTable.studioId} = ${studioId} AND ${creatorStudiosTable.creatorId} IN (${sql.join(
          creatorIds.map((id) => sql`${id}`),
          sql`, `,
        )})`,
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
