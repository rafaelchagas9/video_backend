import { and, desc, eq } from "drizzle-orm";
import { demoSchema, getDemoDatabase } from "@/database/demo";
import { NotFoundError } from "@/utils/errors";
const { demoFavoritesTable, demoThumbnailsTable, demoVideosTable } = demoSchema;

export class FavoritesDemoService {
  add(userId: number, videoId: number): void {
    const video = getDemoDatabase()
      .select({ id: demoVideosTable.id })
      .from(demoVideosTable)
      .where(eq(demoVideosTable.id, videoId))
      .get();
    if (!video) throw new NotFoundError(`Video not found with id: ${videoId}`);
    getDemoDatabase()
      .insert(demoFavoritesTable)
      .values({ userId, videoId, addedAt: new Date().toISOString() })
      .onConflictDoNothing()
      .run();
  }

  remove(userId: number, videoId: number): void {
    getDemoDatabase()
      .delete(demoFavoritesTable)
      .where(
        and(
          eq(demoFavoritesTable.userId, userId),
          eq(demoFavoritesTable.videoId, videoId)
        )
      )
      .run();
  }

  list(userId: number): Array<Record<string, unknown>> {
    return getDemoDatabase()
      .select({
        video: demoVideosTable,
        addedAt: demoFavoritesTable.addedAt,
        thumbnailId: demoThumbnailsTable.videoId,
      })
      .from(demoFavoritesTable)
      .innerJoin(
        demoVideosTable,
        eq(demoVideosTable.id, demoFavoritesTable.videoId)
      )
      .leftJoin(
        demoThumbnailsTable,
        eq(demoThumbnailsTable.videoId, demoVideosTable.id)
      )
      .where(eq(demoFavoritesTable.userId, userId))
      .orderBy(desc(demoFavoritesTable.addedAt))
      .all()
      .map(({ video, addedAt, thumbnailId }) => ({
        ...video,
        file_path: video.filePath,
        file_name: video.fileName,
        is_available: video.isAvailable,
        added_at: addedAt,
        thumbnail_id: thumbnailId,
        thumbnail_url: thumbnailId
          ? `/api/thumbnails/${thumbnailId}/image`
          : null,
      }));
  }

  isFavorite(userId: number, videoId: number): boolean {
    return Boolean(
      getDemoDatabase()
        .select({ videoId: demoFavoritesTable.videoId })
        .from(demoFavoritesTable)
        .where(
          and(
            eq(demoFavoritesTable.userId, userId),
            eq(demoFavoritesTable.videoId, videoId)
          )
        )
        .get()
    );
  }
}

export const favoritesDemoService = new FavoritesDemoService();
