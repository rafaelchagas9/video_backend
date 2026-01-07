import { getDatabase } from "@/config/database";
import { videosService } from "@/modules/videos/videos.service";
import { NotFoundError } from "@/utils/errors";

export class FavoritesService {
  private get db() {
    return getDatabase();
  }

  async add(userId: number, videoId: number): Promise<void> {
    // Verify video exists
    await videosService.findById(videoId);

    // Idempotent - ignore if already exists
    try {
      this.db
        .prepare("INSERT INTO favorites (user_id, video_id) VALUES (?, ?)")
        .run(userId, videoId);
    } catch (error: any) {
      // SQLite UNIQUE constraint violation (already favorited)
      if (error.message?.includes("UNIQUE constraint failed")) {
        // Already favorited, this is fine (idempotent)
        return;
      }
      throw error;
    }
  }

  async remove(userId: number, videoId: number): Promise<void> {
    const result = this.db
      .prepare("DELETE FROM favorites WHERE user_id = ? AND video_id = ?")
      .run(userId, videoId);

    if (result.changes === 0) {
      throw new NotFoundError("Favorite not found");
    }
  }

  async list(userId: number) {
    return this.db
      .prepare(
        `
        SELECT v.*, f.added_at
        FROM videos v
        INNER JOIN favorites f ON v.id = f.video_id
        WHERE f.user_id = ?
        ORDER BY f.added_at DESC
      `,
      )
      .all(userId);
  }

  async isFavorite(userId: number, videoId: number): Promise<boolean> {
    const result = this.db
      .prepare("SELECT 1 FROM favorites WHERE user_id = ? AND video_id = ?")
      .get(userId, videoId);

    return result !== undefined;
  }
}

export const favoritesService = new FavoritesService();
