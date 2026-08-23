import { eq, inArray, and, sql, desc, asc } from "drizzle-orm";
import { db } from "@/config/drizzle";
import {
  videosTable,
  videoCreatorsTable,
  videoTagsTable,
  favoritesTable,
  thumbnailsTable,
  storyboardsTable,
  videoFaceDetectionsTable,
  faceImagesTable,
  artworkAssetsTable,
  editJobsTable,
} from "@/database/schema";
import { logger } from "@/utils/logger";
import { ConflictError, isForeignKeyViolation } from "@/utils/errors";
import type { ListVideosOptions } from "./videos.types";
import { buildVideoFilters } from "./videos.query-builder";
import { env } from "@/config/env";
import { videosDemoService } from "./videos.demo.service";
import { studioAssignmentService } from "@/modules/studios/studio-assignment.service";
import { editsDemoService } from "@/modules/edits/edits.demo.service";
import {
  demoRepository,
  demoSchema,
  getDemoDatabase,
  withDemoTransaction,
} from "@/database/demo";

/**
 * Service for bulk video operations
 */
export class VideosBulkService {
  async assertNoActiveEditJobs(videoIds: number[]): Promise<void> {
    if (videoIds.length === 0) return;
    if (env.DEMO_MODE) {
      if (editsDemoService.hasActiveJobsForVideos(videoIds)) {
        throw new ConflictError(
          "A video cannot be deleted while an edit job is active"
        );
      }
      return;
    }
    const [activeJob] = await db
      .select({ id: editJobsTable.id })
      .from(editJobsTable)
      .where(inArray(editJobsTable.activeVideoId, videoIds))
      .limit(1);
    if (activeJob) {
      throw new ConflictError(
        "A video cannot be deleted while an edit job is active"
      );
    }
  }

  /**
   * Delete multiple videos (includes file cleanup via main service)
   * Note: This should be called from the main videosService.delete() method
   * to ensure proper file cleanup
   */
  async bulkDelete(ids: number[]): Promise<void> {
    if (ids.length === 0) return;
    await this.assertNoActiveEditJobs(ids);
    if (env.DEMO_MODE) {
      for (const id of ids) videosDemoService.delete(id);
      return;
    }

    try {
      // Reject the entire request before touching any database row or file.
      // 1. Fetch source file paths for the videos being deleted
      const videos = await db
        .select({ filePath: videosTable.filePath })
        .from(videosTable)
        .where(inArray(videosTable.id, ids));

      // 2. Resolve derived files while their catalog rows still exist.
      const artifactPaths = await this.getVideoArtifactPaths(ids);

      // 3. Delete catalog rows first. The active-video FK is the race-safe
      // backstop: no physical file is touched if a job became active meanwhile.
      await db.delete(videosTable).where(inArray(videosTable.id, ids));

      // 4. Delete source and derived files (no-op when already unavailable).
      const fs = await import("fs");
      const paths = [
        ...videos.map((video) => video.filePath),
        ...artifactPaths,
      ].filter((path): path is string => Boolean(path));
      for (const path of paths) {
        if (fs.existsSync(path)) {
          try {
            fs.unlinkSync(path);
          } catch (error) {
            logger.warn(
              { error, path },
              "Failed to delete video file in bulk operation"
            );
          }
        }
      }
    } catch (error) {
      if (error instanceof ConflictError) throw error;
      if (
        isForeignKeyViolation(error) &&
        this.getConstraintName(error) ===
          "edit_jobs_active_video_id_videos_id_fk"
      ) {
        throw new ConflictError(
          "A video cannot be deleted while an edit job is active"
        );
      }
      logger.error({ error, ids }, "Failed to execute bulk delete operation");
      throw error;
    }
  }

  /**
   * Delete the on-disk derived artifact files (thumbnails, storyboard
   * sprite/VTT, and extracted face images) for the given videos.
   *
   * The corresponding database rows are removed separately via FK cascade when
   * the video records are deleted, so this only handles the physical files that
   * would otherwise be orphaned on disk.
   */
  async deleteVideoArtifactFiles(videoIds: number[]): Promise<void> {
    if (videoIds.length === 0) return;
    if (env.DEMO_MODE) return;

    const paths = await this.getVideoArtifactPaths(videoIds);

    const fs = await import("fs");
    for (const path of paths) {
      if (fs.existsSync(path)) {
        try {
          fs.unlinkSync(path);
        } catch (error) {
          logger.warn({ error, path }, "Failed to delete video artifact file");
        }
      }
    }
  }

  private async getVideoArtifactPaths(videoIds: number[]): Promise<string[]> {
    const [thumbnails, storyboards, faceImages, artworkAssets] =
      await Promise.all([
        db
          .select({ filePath: thumbnailsTable.filePath })
          .from(thumbnailsTable)
          .where(inArray(thumbnailsTable.videoId, videoIds)),
        db
          .select({
            spritePath: storyboardsTable.spritePath,
            vttPath: storyboardsTable.vttPath,
          })
          .from(storyboardsTable)
          .where(inArray(storyboardsTable.videoId, videoIds)),
        db
          .select({ filePath: faceImagesTable.filePath })
          .from(faceImagesTable)
          .innerJoin(
            videoFaceDetectionsTable,
            eq(faceImagesTable.detectionId, videoFaceDetectionsTable.id)
          )
          .where(inArray(videoFaceDetectionsTable.videoId, videoIds)),
        db
          .select({ filePath: artworkAssetsTable.filePath })
          .from(artworkAssetsTable)
          .where(inArray(artworkAssetsTable.videoId, videoIds)),
      ]);

    const paths: string[] = [];
    for (const thumbnail of thumbnails) {
      if (thumbnail.filePath) paths.push(thumbnail.filePath);
    }
    for (const storyboard of storyboards) {
      if (storyboard.spritePath) paths.push(storyboard.spritePath);
      if (storyboard.vttPath) paths.push(storyboard.vttPath);
    }
    for (const faceImage of faceImages) {
      if (faceImage.filePath) paths.push(faceImage.filePath);
    }
    for (const artworkAsset of artworkAssets) {
      if (artworkAsset.filePath) paths.push(artworkAsset.filePath);
    }

    return paths;
  }

  private getConstraintName(error: unknown): string | undefined {
    let current: unknown = error;
    const seen = new Set<object>();
    while (current && typeof current === "object") {
      if (seen.has(current)) return undefined;
      seen.add(current);
      const constraint = (current as { constraint?: unknown }).constraint;
      if (typeof constraint === "string") return constraint;
      current = (current as { cause?: unknown }).cause;
    }
    return undefined;
  }

  /**
   * Bulk add/remove creators from videos
   */
  async bulkUpdateCreators(input: {
    videoIds: number[];
    creatorIds: number[];
    action: "add" | "remove";
  }): Promise<void> {
    const { videoIds, creatorIds, action } = input;
    if (videoIds.length === 0 || creatorIds.length === 0) return;
    if (env.DEMO_MODE) {
      videosDemoService.updateRelationships(
        videoIds,
        "creators",
        creatorIds,
        action
      );
      return;
    }

    await db.transaction(async (tx) => {
      if (action === "add") {
        // Generate all combinations of videoId x creatorId
        const values = videoIds.flatMap((videoId) =>
          creatorIds.map((creatorId) => ({
            videoId,
            creatorId,
          }))
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
              inArray(videoCreatorsTable.creatorId, creatorIds)
            )
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
    action: "add" | "remove";
  }): Promise<void> {
    const { videoIds, tagIds, action } = input;
    if (videoIds.length === 0 || tagIds.length === 0) return;
    if (env.DEMO_MODE) {
      videosDemoService.updateRelationships(videoIds, "tags", tagIds, action);
      return;
    }

    await db.transaction(async (tx) => {
      if (action === "add") {
        // Generate all combinations of videoId x tagId
        const values = videoIds.flatMap((videoId) =>
          tagIds.map((tagId) => ({
            videoId,
            tagId,
          }))
        );

        // Bulk insert with conflict handling
        await tx.insert(videoTagsTable).values(values).onConflictDoNothing();
      } else {
        // Remove all specified tag-video relationships
        await tx
          .delete(videoTagsTable)
          .where(
            and(
              inArray(videoTagsTable.videoId, videoIds),
              inArray(videoTagsTable.tagId, tagIds)
            )
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
    action: "add" | "remove";
  }): Promise<void> {
    const { videoIds, studioIds, action } = input;
    if (videoIds.length === 0 || studioIds.length === 0) return;
    if (env.DEMO_MODE) {
      videosDemoService.updateRelationships(
        videoIds,
        "studios",
        studioIds,
        action
      );
      return;
    }

    await db.transaction(async (tx) => {
      if (action === "add") {
        await studioAssignmentService.linkMany(videoIds, studioIds, tx);
      } else {
        // Remove all specified studio-video relationships
        await studioAssignmentService.unlinkMany(videoIds, studioIds, tx);
      }
    });
  }

  /**
   * Bulk add/remove favorites
   */
  async bulkUpdateFavorites(
    userId: number,
    input: { videoIds: number[]; isFavorite: boolean }
  ): Promise<void> {
    const { videoIds, isFavorite } = input;
    if (videoIds.length === 0) return;
    if (env.DEMO_MODE) {
      videosDemoService.bulkUpdateFavorites(
        userId,
        videoIds,
        isFavorite ? "add" : "remove"
      );
      return;
    }

    await db.transaction(async (tx) => {
      if (isFavorite) {
        // Add favorites
        const values = videoIds.map((videoId) => ({
          userId,
          videoId,
        }));

        await tx.insert(favoritesTable).values(values).onConflictDoNothing();
      } else {
        // Remove favorites
        await tx
          .delete(favoritesTable)
          .where(
            and(
              eq(favoritesTable.userId, userId),
              inArray(favoritesTable.videoId, videoIds)
            )
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
      total_size_bytes: string;
      videos: Array<{
        id: number;
        file_name: string;
        file_path: string;
        file_size_bytes: number;
        indexed_at: string;
      }>;
    }[]
  > {
    if (env.DEMO_MODE) return videosDemoService.getDuplicates();
    // Find all file_hash values that appear more than once
    const duplicateHashes = await db
      .select({
        fileHash: videosTable.fileHash,
        count: sql<number>`COUNT(*)::int`,
        totalSizeBytes: sql<bigint>`SUM(${videosTable.fileSizeBytes})::bigint`,
      })
      .from(videosTable)
      .where(
        sql`${videosTable.fileHash} IS NOT NULL AND ${videosTable.fileHash} != ''`
      )
      .groupBy(videosTable.fileHash)
      .having(sql`COUNT(*) > 1`)
      .orderBy(desc(sql`SUM(${videosTable.fileSizeBytes})`));

    const hashes = duplicateHashes.map((dup) => dup.fileHash!).filter(Boolean);
    if (hashes.length === 0) return [];

    // Fetch all videos matching the duplicate hashes in a single query
    const allVideos = await db
      .select({
        id: videosTable.id,
        fileName: videosTable.fileName,
        filePath: videosTable.filePath,
        fileSizeBytes: videosTable.fileSizeBytes,
        indexedAt: videosTable.indexedAt,
        fileHash: videosTable.fileHash,
      })
      .from(videosTable)
      .where(inArray(videosTable.fileHash, hashes))
      .orderBy(asc(videosTable.indexedAt));

    // Group videos by file hash in memory
    const videosByHash = new Map<string, typeof allVideos>();
    for (const video of allVideos) {
      if (video.fileHash) {
        const list = videosByHash.get(video.fileHash) ?? [];
        list.push(video);
        videosByHash.set(video.fileHash, list);
      }
    }

    return duplicateHashes.map((dup) => {
      const videos = videosByHash.get(dup.fileHash!) ?? [];
      return {
        file_hash: dup.fileHash!,
        count: dup.count,
        total_size_bytes: dup.totalSizeBytes?.toString() ?? "0",
        videos: videos.map((v) => ({
          id: v.id,
          file_name: v.fileName,
          file_path: v.filePath,
          file_size_bytes: v.fileSizeBytes,
          indexed_at: v.indexedAt.toISOString(),
        })),
      };
    });
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
    }
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
    if (env.DEMO_MODE) {
      const videoIds = demoRepository
        .getVideos({ ...filter, limit: 10_000 })
        .data.map((video: { id: number }) => video.id);
      const counts = {
        creators_added: 0,
        creators_removed: 0,
        tags_added: 0,
        tags_removed: 0,
        studios_added: 0,
        studios_removed: 0,
      };
      const apply = (
        kind: "creators" | "tags" | "studios",
        ids: number[] | undefined,
        action: "add" | "remove"
      ) => {
        if (!ids?.length || !videoIds.length) return;
        const before = this.countDemoRelationships(kind, videoIds, ids);
        videosDemoService.updateRelationships(videoIds, kind, ids, action);
        const after = this.countDemoRelationships(kind, videoIds, ids);
        const key =
          `${kind}_${action === "add" ? "added" : "removed"}` as keyof typeof counts;
        counts[key] = Math.abs(after - before);
      };
      withDemoTransaction(() => {
        apply("creators", actions.addCreatorIds, "add");
        apply("creators", actions.removeCreatorIds, "remove");
        apply("tags", actions.addTagIds, "add");
        apply("tags", actions.removeTagIds, "remove");
        apply("studios", actions.addStudioIds, "add");
        apply("studios", actions.removeStudioIds, "remove");
      });
      return {
        matched: videoIds.length,
        affected: videoIds.length,
        errors: 0,
        details: counts,
      };
    }
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
            }))
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
                inArray(videoCreatorsTable.creatorId, actions.removeCreatorIds)
              )
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
            }))
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
                inArray(videoTagsTable.tagId, actions.removeTagIds)
              )
            )
            .returning({ videoId: videoTagsTable.videoId });

          tagsRemoved = result.length;
        }

        // Add studios
        if (actions.addStudioIds && actions.addStudioIds.length > 0) {
          studiosAdded = await studioAssignmentService.linkMany(videoIds, actions.addStudioIds, tx);
        }

        // Remove studios
        if (actions.removeStudioIds && actions.removeStudioIds.length > 0) {
          studiosRemoved = await studioAssignmentService.unlinkMany(videoIds, actions.removeStudioIds, tx);
        }
      } catch (error) {
        errors++;
        logger.error({ error }, "Failed to apply bulk conditional actions");
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

  private countDemoRelationships(
    kind: "creators" | "tags" | "studios",
    videoIds: number[],
    targetIds: number[]
  ): number {
    if (kind === "creators")
      return getDemoDatabase()
        .select()
        .from(demoSchema.demoVideoCreatorsTable)
        .where(
          and(
            inArray(demoSchema.demoVideoCreatorsTable.videoId, videoIds),
            inArray(demoSchema.demoVideoCreatorsTable.creatorId, targetIds)
          )
        )
        .all().length;
    if (kind === "tags")
      return getDemoDatabase()
        .select()
        .from(demoSchema.demoVideoTagsTable)
        .where(
          and(
            inArray(demoSchema.demoVideoTagsTable.videoId, videoIds),
            inArray(demoSchema.demoVideoTagsTable.tagId, targetIds)
          )
        )
        .all().length;
    return getDemoDatabase()
      .select()
      .from(demoSchema.demoVideoStudiosTable)
      .where(
        and(
          inArray(demoSchema.demoVideoStudiosTable.videoId, videoIds),
          inArray(demoSchema.demoVideoStudiosTable.studioId, targetIds)
        )
      )
      .all().length;
  }
}

export const videosBulkService = new VideosBulkService();
