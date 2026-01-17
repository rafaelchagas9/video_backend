import { eq, and, asc } from 'drizzle-orm';
import { db } from '@/config/drizzle';
import { videoMetadataTable } from '@/database/schema';
import { NotFoundError } from '@/utils/errors';

/**
 * Service for managing custom video metadata (key-value pairs)
 */
export class VideosMetadataService {
  /**
   * Get all metadata for a video
   */
  async getMetadata(
    videoId: number,
  ): Promise<{ key: string; value: string }[]> {
    const metadata = await db
      .select({
        key: videoMetadataTable.key,
        value: videoMetadataTable.value,
      })
      .from(videoMetadataTable)
      .where(eq(videoMetadataTable.videoId, videoId))
      .orderBy(asc(videoMetadataTable.key));

    return metadata;
  }

  /**
   * Set metadata key-value (upsert)
   */
  async setMetadata(
    videoId: number,
    key: string,
    value: string,
  ): Promise<void> {
    await db
      .insert(videoMetadataTable)
      .values({
        videoId,
        key,
        value,
      })
      .onConflictDoUpdate({
        target: [videoMetadataTable.videoId, videoMetadataTable.key],
        set: {
          value,
          updatedAt: new Date(),
        },
      });
  }

  /**
   * Delete metadata key
   */
  async deleteMetadata(videoId: number, key: string): Promise<void> {
    const result = await db
      .delete(videoMetadataTable)
      .where(
        and(
          eq(videoMetadataTable.videoId, videoId),
          eq(videoMetadataTable.key, key),
        ),
      )
      .returning({ id: videoMetadataTable.id });

    if (result.length === 0) {
      throw new NotFoundError(`Metadata key "${key}" not found`);
    }
  }
}

export const videosMetadataService = new VideosMetadataService();
