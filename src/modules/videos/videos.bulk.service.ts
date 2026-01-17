import { eq, inArray, and, sql, desc, asc } from 'drizzle-orm';
import { db } from '@/config/drizzle';
import {
  videosTable,
  videoCreatorsTable,
  videoTagsTable,
  videoStudiosTable,
  favoritesTable,
} from '@/database/schema';
import { logger } from '@/utils/logger';
import type { ListVideosOptions } from './videos.types';
import { buildVideoFilters } from './videos.query-builder';

/**
 * Service for bulk video operations
 */
export class VideosBulkService {
  /**
   * Delete multiple videos (includes file cleanup via main service)
   * Note: This should be called from the main videosService.delete() method
   * to ensure proper file cleanup
   */
  async bulkDelete(ids: number[]): Promise<void> {
    if (ids.length === 0) return;

    // Import here to avoid circular dependency
    const { videosService } = await import('./videos.service');

    // Delete each video individually to ensure file cleanup
    for (const id of ids) {
      try {
        await videosService.delete(id);
      } catch (error) {
        logger.warn(
          { error, videoId: id },
          'Failed to delete video in bulk operation',
        );
        // Continue with remaining videos even if one fails
      }
    }
  }

  /**
   * Bulk add/remove creators from videos
   */
  async bulkUpdateCreators(input: {
    videoIds: number[];
    creatorIds: number[];
    action: 'add' | 'remove';
  }): Promise<void> {
    const { videoIds, creatorIds, action } = input;
    if (videoIds.length === 0 || creatorIds.length === 0) return;

    await db.transaction(async (tx) => {
      if (action === 'add') {
        // Generate all combinations of videoId x creatorId
        const values = videoIds.flatMap((videoId) =>
          creatorIds.map((creatorId) => ({
            videoId,
            creatorId,
          })),
        );

        // Bulk insert with conflict handling
        await tx
          .insert(videoCreatorsTable)
          .values(values)
          .onConflictDoNothing();
      } else {
        // Remove all specified creator-video relationships
        await tx
          .delete(videoCreatorsTable)
          .where(
            and(
              inArray(videoCreatorsTable.videoId, videoIds),
              inArray(videoCreatorsTable.creatorId, creatorIds),
            ),
          );
      }
    });
  }

  /**
   * Bulk add/remove tags from videos
   */
  async bulkUpdateTags(input: {
    videoIds: number[];
    tagIds: number[];
    action: 'add' | 'remove';
  }): Promise<void> {
    const { videoIds, tagIds, action } = input;
    if (videoIds.length === 0 || tagIds.length === 0) return;

    await db.transaction(async (tx) => {
      if (action === 'add') {
        // Generate all combinations of videoId x tagId
        const values = videoIds.flatMap((videoId) =>
          tagIds.map((tagId) => ({
            videoId,
            tagId,
          })),
        );

        // Bulk insert with conflict handling
        await tx
          .insert(videoTagsTable)
          .values(values)
          .onConflictDoNothing();
      } else {
        // Remove all specified tag-video relationships
        await tx
          .delete(videoTagsTable)
          .where(
            and(
              inArray(videoTagsTable.videoId, videoIds),
              inArray(videoTagsTable.tagId, tagIds),
            ),
          );
      }
    });
  }

  /**
   * Bulk add/remove studios from videos
   */
  async bulkUpdateStudios(input: {
    videoIds: number[];
    studioIds: number[];
    action: 'add' | 'remove';
  }): Promise<void> {
    const { videoIds, studioIds, action } = input;
    if (videoIds.length === 0 || studioIds.length === 0) return;

    await db.transaction(async (tx) => {
      if (action === 'add') {
        // Generate all combinations of videoId x studioId
        const values = videoIds.flatMap((videoId) =>
          studioIds.map((studioId) => ({
            videoId,
            studioId,
          })),
        );

        // Bulk insert with conflict handling
        await tx
          .insert(videoStudiosTable)
          .values(values)
          .onConflictDoNothing();
      } else {
        // Remove all specified studio-video relationships
        await tx
          .delete(videoStudiosTable)
          .where(
            and(
              inArray(videoStudiosTable.videoId, videoIds),
              inArray(videoStudiosTable.studioId, studioIds),
            ),
          );
      }
    });
  }

  /**
   * Bulk add/remove favorites
   */
  async bulkUpdateFavorites(
    userId: number,
    input: { videoIds: number[]; isFavorite: boolean },
  ): Promise<void> {
    const { videoIds, isFavorite } = input;
    if (videoIds.length === 0) return;

    await db.transaction(async (tx) => {
      if (isFavorite) {
        // Add favorites
        const values = videoIds.map((videoId) => ({
          userId,
          videoId,
        }));

        await tx
          .insert(favoritesTable)
          .values(values)
          .onConflictDoNothing();
      } else {
        // Remove favorites
        await tx
          .delete(favoritesTable)
          .where(
            and(
              eq(favoritesTable.userId, userId),
              inArray(favoritesTable.videoId, videoIds),
            ),
          );
      }
    });
  }

  /**
   * Find duplicate videos by file hash
   */
  async getDuplicates(): Promise<
    {
      file_hash: string;
      count: number;
      total_size_bytes: number;
      videos: Array<{
        id: number;
        file_name: string;
        file_path: string;
        file_size_bytes: number;
        indexed_at: string;
      }>;
    }[]
  > {
    // Find all file_hash values that appear more than once
    const duplicateHashes = await db
      .select({
        fileHash: videosTable.fileHash,
        count: sql<number>`COUNT(*)::int`,
        totalSizeBytes: sql<number>`SUM(${videosTable.fileSizeBytes})::int`,
      })
      .from(videosTable)
      .where(sql`${videosTable.fileHash} IS NOT NULL AND ${videosTable.fileHash} != ''`)
      .groupBy(videosTable.fileHash)
      .having(sql`COUNT(*) > 1`)
      .orderBy(desc(sql`SUM(${videosTable.fileSizeBytes})`));

    // For each duplicate hash, get the video details
    const result = await Promise.all(
      duplicateHashes.map(async (dup) => {
        const videos = await db
          .select({
            id: videosTable.id,
            fileName: videosTable.fileName,
            filePath: videosTable.filePath,
            fileSizeBytes: videosTable.fileSizeBytes,
            indexedAt: videosTable.indexedAt,
          })
          .from(videosTable)
          .where(eq(videosTable.fileHash, dup.fileHash!))
          .orderBy(asc(videosTable.indexedAt));

        return {
          file_hash: dup.fileHash!,
          count: dup.count,
          total_size_bytes: dup.totalSizeBytes,
          videos: videos.map((v) => ({
            id: v.id,
            file_name: v.fileName,
            file_path: v.filePath,
            file_size_bytes: v.fileSizeBytes,
            indexed_at: v.indexedAt.toISOString(),
          })),
        };
      }),
    );

    return result;
  }

  /**
   * Apply bulk actions to videos matching a filter
   */
  async bulkConditionalApply(
    userId: number,
    filter: ListVideosOptions,
    actions: {
      addCreatorIds?: number[];
      removeCreatorIds?: number[];
      addTagIds?: number[];
      removeTagIds?: number[];
      addStudioIds?: number[];
      removeStudioIds?: number[];
    },
  ): Promise<{
    matched: number;
    affected: number;
    errors: number;
    details: {
      creators_added: number;
      creators_removed: number;
      tags_added: number;
      tags_removed: number;
      studios_added: number;
      studios_removed: number;
    };
  }> {
    // Build filter conditions
    const { conditions } = buildVideoFilters(userId, filter);

    // Get matching video IDs
    const matchingVideos = await db
      .selectDistinct({ id: videosTable.id })
      .from(videosTable)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(asc(videosTable.id));

    const videoIds = matchingVideos.map((v) => v.id);

    if (videoIds.length === 0) {
      return {
        matched: 0,
        affected: 0,
        errors: 0,
        details: {
          creators_added: 0,
          creators_removed: 0,
          tags_added: 0,
          tags_removed: 0,
          studios_added: 0,
          studios_removed: 0,
        },
      };
    }

    let errors = 0;
    let creatorsAdded = 0;
    let creatorsRemoved = 0;
    let tagsAdded = 0;
    let tagsRemoved = 0;
    let studiosAdded = 0;
    let studiosRemoved = 0;

    await db.transaction(async (tx) => {
      try {
        // Add creators
        if (actions.addCreatorIds && actions.addCreatorIds.length > 0) {
          const values = videoIds.flatMap((videoId) =>
            actions.addCreatorIds!.map((creatorId) => ({
              videoId,
              creatorId,
            })),
          );

          const result = await tx
            .insert(videoCreatorsTable)
            .values(values)
            .onConflictDoNothing()
            .returning({ videoId: videoCreatorsTable.videoId });

          creatorsAdded = result.length;
        }

        // Remove creators
        if (actions.removeCreatorIds && actions.removeCreatorIds.length > 0) {
          const result = await tx
            .delete(videoCreatorsTable)
            .where(
              and(
                inArray(videoCreatorsTable.videoId, videoIds),
                inArray(videoCreatorsTable.creatorId, actions.removeCreatorIds),
              ),
            )
            .returning({ videoId: videoCreatorsTable.videoId });

          creatorsRemoved = result.length;
        }

        // Add tags
        if (actions.addTagIds && actions.addTagIds.length > 0) {
          const values = videoIds.flatMap((videoId) =>
            actions.addTagIds!.map((tagId) => ({
              videoId,
              tagId,
            })),
          );

          const result = await tx
            .insert(videoTagsTable)
            .values(values)
            .onConflictDoNothing()
            .returning({ videoId: videoTagsTable.videoId });

          tagsAdded = result.length;
        }

        // Remove tags
        if (actions.removeTagIds && actions.removeTagIds.length > 0) {
          const result = await tx
            .delete(videoTagsTable)
            .where(
              and(
                inArray(videoTagsTable.videoId, videoIds),
                inArray(videoTagsTable.tagId, actions.removeTagIds),
              ),
            )
            .returning({ videoId: videoTagsTable.videoId });

          tagsRemoved = result.length;
        }

        // Add studios
        if (actions.addStudioIds && actions.addStudioIds.length > 0) {
          const values = videoIds.flatMap((videoId) =>
            actions.addStudioIds!.map((studioId) => ({
              videoId,
              studioId,
            })),
          );

          const result = await tx
            .insert(videoStudiosTable)
            .values(values)
            .onConflictDoNothing()
            .returning({ videoId: videoStudiosTable.videoId });

          studiosAdded = result.length;
        }

        // Remove studios
        if (actions.removeStudioIds && actions.removeStudioIds.length > 0) {
          const result = await tx
            .delete(videoStudiosTable)
            .where(
              and(
                inArray(videoStudiosTable.videoId, videoIds),
                inArray(videoStudiosTable.studioId, actions.removeStudioIds),
              ),
            )
            .returning({ videoId: videoStudiosTable.videoId });

          studiosRemoved = result.length;
        }
      } catch (error) {
        errors++;
        logger.error({ error }, 'Failed to apply bulk conditional actions');
        throw error;
      }
    });

    return {
      matched: videoIds.length,
      affected: videoIds.length - errors,
      errors,
      details: {
        creators_added: creatorsAdded,
        creators_removed: creatorsRemoved,
        tags_added: tagsAdded,
        tags_removed: tagsRemoved,
        studios_added: studiosAdded,
        studios_removed: studiosRemoved,
      },
    };
  }
}

export const videosBulkService = new VideosBulkService();
