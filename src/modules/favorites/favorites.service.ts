import { db } from "@/config/drizzle";
import { eq, and, sql } from "drizzle-orm";
import { favoritesTable } from "@/database/schema";
import { videosService } from "@/modules/videos/videos.service";
import { API_PREFIX } from "@/config/constants";

export class FavoritesService {
  async add(userId: number, videoId: number): Promise<void> {
    // Verify video exists
    await videosService.findById(videoId);

    // Idempotent - ignore if already exists
    try {
      await db.insert(favoritesTable).values({
        userId,
        videoId,
      });
    } catch (error: any) {
      // PostgreSQL UNIQUE constraint violation (already favorited)
      if (error.code === "23505") {
        // Already favorited, this is fine (idempotent)
        return;
      }
      throw error;
    }
  }

  async remove(userId: number, videoId: number): Promise<void> {
    await db
      .delete(favoritesTable)
      .where(
        and(
          eq(favoritesTable.userId, userId),
          eq(favoritesTable.videoId, videoId),
        ),
      );

    // Drizzle doesn't return rowCount, so we can't verify if it was deleted
    // The delete will succeed even if no rows match
  }

  async list(userId: number) {
    const query = sql`
      SELECT v.*, f.added_at, t.id as thumbnail_id
      FROM videos v
      INNER JOIN favorites f ON v.id = f.video_id
      LEFT JOIN thumbnails t ON v.id = t.video_id
      WHERE f.user_id = ${userId}
      ORDER BY f.added_at DESC
    `;

    const result = await db.execute(query);
    const videos = result as any[];

    return videos.map((v) => ({
      ...v,
      thumbnail_url: v.thumbnail_id
        ? `${API_PREFIX}/thumbnails/${v.thumbnail_id}/image`
        : null,
    }));
  }

  async isFavorite(userId: number, videoId: number): Promise<boolean> {
    const result = await db
      .select()
      .from(favoritesTable)
      .where(
        and(
          eq(favoritesTable.userId, userId),
          eq(favoritesTable.videoId, videoId),
        ),
      )
      .limit(1);

    return result !== null && result.length > 0;
  }
}

export const favoritesService = new FavoritesService();
