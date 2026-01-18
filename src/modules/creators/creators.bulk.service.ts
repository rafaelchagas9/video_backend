import { creatorsService } from "./creators.service";
import { creatorsPlatformsService } from "./creators.platforms.service";
import { creatorsSocialService } from "./creators.social.service";
import { creatorsRelationshipsService } from "./creators.relationships.service";
import { logger } from "@/utils/logger";
import type {
  BulkCreatorImportItem,
  BulkImportPreviewItem,
  BulkImportResult,
  Creator,
} from "./creators.types";
import { db } from "@/config/drizzle";
import { creatorsTable, platformsTable, videosTable } from "@/database/schema";
import { eq } from "drizzle-orm";

export class CreatorsBulkService {
  // Bulk Import with Preview
  async bulkImport(
    items: BulkCreatorImportItem[],
    mode: "merge" | "replace",
    dryRun: boolean,
  ): Promise<BulkImportResult> {
    const previewItems: BulkImportPreviewItem[] = [];
    let willCreate = 0;
    let willUpdate = 0;
    let errors = 0;

    // First pass: validate and compute preview
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const validationErrors: string[] = [];
      const missingDependencies: string[] = [];
      let existingCreator: Creator | null = null;
      let action: "create" | "update" = "create";

      // Check if updating existing creator
      if (item.id) {
        try {
          existingCreator = await creatorsService.findById(item.id);
          action = "update";
        } catch {
          validationErrors.push(`Creator with id ${item.id} not found`);
        }
      } else {
        // Check if creator with same name exists
        const existing = await db
          .select()
          .from(creatorsTable)
          .where(eq(creatorsTable.name, item.name))
          .limit(1)
          .then((rows) => rows[0] || null);

        if (existing) {
          existingCreator = {
            id: existing.id,
            name: existing.name,
            description: existing.description,
            profile_picture_path: existing.profilePicturePath,
            face_thumbnail_path: existing.faceThumbnailPath,
            created_at: existing.createdAt.toISOString(),
            updated_at: existing.updatedAt.toISOString(),
          };
          action = "update";
        }
      }

      // Validate platform IDs exist
      if (item.platforms && item.platforms.length > 0) {
        for (const platform of item.platforms) {
          const platformExists = await db
            .select({ id: platformsTable.id })
            .from(platformsTable)
            .where(eq(platformsTable.id, platform.platform_id))
            .limit(1)
            .then((rows) => rows[0] || null);

          if (!platformExists) {
            missingDependencies.push(
              `Platform id ${platform.platform_id} not found`,
            );
          }
        }
      }

      // Validate video IDs exist
      if (item.link_video_ids && item.link_video_ids.length > 0) {
        for (const videoId of item.link_video_ids) {
          const video = await db
            .select({ id: videosTable.id })
            .from(videosTable)
            .where(eq(videosTable.id, videoId))
            .limit(1)
            .then((rows) => rows[0] || null);

          if (!video) {
            missingDependencies.push(`Video id ${videoId} not found`);
          }
        }
      }

      // Compute changes
      const changes: BulkImportPreviewItem["changes"] = {};

      if (existingCreator) {
        if (existingCreator.name !== item.name) {
          changes.name = { from: existingCreator.name, to: item.name };
        }
        if (
          item.description !== undefined &&
          existingCreator.description !== (item.description ?? null)
        ) {
          changes.description = {
            from: existingCreator.description,
            to: item.description ?? null,
          };
        }
        if (item.profile_picture_url) {
          changes.profile_picture = { action: "set" };
        }

        // Compute platform changes
        if (item.platforms) {
          const existingPlatforms =
            await creatorsPlatformsService.getPlatformProfiles(
              existingCreator.id,
            );
          let add = 0,
            update = 0,
            remove = 0;

          for (const p of item.platforms) {
            const existing = existingPlatforms.find(
              (ep) =>
                ep.platform_id === p.platform_id && ep.username === p.username,
            );
            if (existing) {
              if (
                existing.profile_url !== p.profile_url ||
                existing.is_primary !== (p.is_primary ?? false)
              )
                update++;
            } else {
              add++;
            }
          }

          if (mode === "replace") {
            remove = existingPlatforms.filter(
              (ep) =>
                !item.platforms!.some(
                  (p) =>
                    p.platform_id === ep.platform_id &&
                    p.username === ep.username,
                ),
            ).length;
          }

          if (add > 0 || update > 0 || remove > 0) {
            changes.platforms = {
              add,
              update,
              remove: mode === "replace" ? remove : undefined,
            };
          }
        }

        // Compute social link changes
        if (item.social_links) {
          const existingLinks = await creatorsSocialService.getSocialLinks(
            existingCreator.id,
          );
          let add = 0,
            update = 0,
            remove = 0;

          for (const sl of item.social_links) {
            const existing = existingLinks.find(
              (el) => el.platform_name === sl.platform_name,
            );
            if (existing) {
              if (existing.url !== sl.url) update++;
            } else {
              add++;
            }
          }

          if (mode === "replace") {
            remove = existingLinks.filter(
              (el) =>
                !item.social_links!.some(
                  (sl) => sl.platform_name === el.platform_name,
                ),
            ).length;
          }

          if (add > 0 || update > 0 || remove > 0) {
            changes.social_links = {
              add,
              update,
              remove: mode === "replace" ? remove : undefined,
            };
          }
        }

        // Compute video link changes
        if (item.link_video_ids) {
          const existingVideos = await creatorsRelationshipsService.getVideos(
            existingCreator.id,
          );
          const existingVideoIds = existingVideos.map((v) => v.id);
          const add = item.link_video_ids.filter(
            (id) => !existingVideoIds.includes(id),
          ).length;
          const remove =
            mode === "replace"
              ? existingVideoIds.filter(
                  (id) => !item.link_video_ids!.includes(id),
                ).length
              : undefined;

          if (add > 0 || (remove && remove > 0)) {
            changes.videos = { add, remove };
          }
        }
      } else {
        // New creator
        changes.name = { from: null, to: item.name };
        if (item.description) {
          changes.description = { from: null, to: item.description };
        }
        if (item.profile_picture_url) {
          changes.profile_picture = { action: "set" };
        }
        if (item.platforms && item.platforms.length > 0) {
          changes.platforms = { add: item.platforms.length, update: 0 };
        }
        if (item.social_links && item.social_links.length > 0) {
          changes.social_links = { add: item.social_links.length, update: 0 };
        }
        if (item.link_video_ids && item.link_video_ids.length > 0) {
          changes.videos = { add: item.link_video_ids.length };
        }
      }

      const hasErrors =
        validationErrors.length > 0 || missingDependencies.length > 0;
      if (hasErrors) errors++;
      else if (action === "create") willCreate++;
      else willUpdate++;

      previewItems.push({
        index: i,
        action,
        resolved_id: existingCreator?.id ?? null,
        name: item.name,
        validation_errors: validationErrors,
        changes,
        missing_dependencies: missingDependencies,
      });
    }

    // If not dry run and no errors, apply changes
    if (!dryRun && errors === 0) {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const preview = previewItems[i];
        let creatorId: number;

        if (preview.action === "create") {
          const creator = await creatorsService.create({
            name: item.name,
            description: item.description,
          });
          creatorId = creator.id;
          preview.resolved_id = creatorId;
        } else {
          creatorId = preview.resolved_id!;
          if (
            preview.changes.name ||
            preview.changes.description !== undefined
          ) {
            await creatorsService.update(creatorId, {
              name: preview.changes.name?.to ?? undefined,
              description: item.description,
            });
          }
        }

        // Set profile picture from URL
        if (item.profile_picture_url) {
          try {
            await creatorsSocialService.setPictureFromUrl(
              creatorId,
              item.profile_picture_url,
            );
          } catch (error: any) {
            logger.warn(
              { error, creatorId, url: item.profile_picture_url },
              "Failed to set profile picture from URL",
            );
          }
        }

        // Handle platforms
        if (item.platforms && item.platforms.length > 0) {
          if (mode === "replace") {
            const existing =
              await creatorsPlatformsService.getPlatformProfiles(creatorId);
            for (const ep of existing) {
              if (
                !item.platforms.some(
                  (p) =>
                    p.platform_id === ep.platform_id &&
                    p.username === ep.username,
                )
              ) {
                await creatorsPlatformsService.deletePlatformProfile(ep.id);
              }
            }
          }
          await creatorsPlatformsService.bulkUpsertPlatforms(
            creatorId,
            item.platforms,
          );
        }

        // Handle social links
        if (item.social_links && item.social_links.length > 0) {
          if (mode === "replace") {
            const existing =
              await creatorsSocialService.getSocialLinks(creatorId);
            for (const el of existing) {
              if (
                !item.social_links.some(
                  (sl) => sl.platform_name === el.platform_name,
                )
              ) {
                await creatorsSocialService.deleteSocialLink(el.id);
              }
            }
          }
          await creatorsSocialService.bulkUpsertSocialLinks(
            creatorId,
            item.social_links,
          );
        }

        // Handle video links
        if (item.link_video_ids && item.link_video_ids.length > 0) {
          if (mode === "replace") {
            const existingVideos =
              await creatorsRelationshipsService.getVideos(creatorId);
            for (const v of existingVideos) {
              if (!item.link_video_ids.includes(v.id)) {
                await creatorsRelationshipsService.removeFromVideo(
                  v.id,
                  creatorId,
                );
              }
            }
          }
          for (const videoId of item.link_video_ids) {
            try {
              await creatorsRelationshipsService.addToVideo(videoId, creatorId);
            } catch {
              // Ignore duplicates
            }
          }
        }
      }
    }

    return {
      success: errors === 0,
      dry_run: dryRun,
      items: previewItems,
      summary: {
        will_create: willCreate,
        will_update: willUpdate,
        errors,
      },
    };
  }
}

export const creatorsBulkService = new CreatorsBulkService();
