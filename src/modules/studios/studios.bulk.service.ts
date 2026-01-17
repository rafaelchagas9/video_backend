import { studiosService } from "./studios.service";
import { studiosSocialService } from "./studios.social.service";
import { studiosRelationshipsService } from "./studios.relationships.service";
import { logger } from "@/utils/logger";
import type {
  BulkStudioImportItem,
  BulkStudioImportPreviewItem,
  BulkStudioImportResult,
  Studio,
} from "./studios.types";
import { db } from "@/config/drizzle";
import { studiosTable, creatorsTable, videosTable } from "@/database/schema";
import { eq } from "drizzle-orm";

export class StudiosBulkService {
  // Bulk Import with Preview
  async bulkImport(
    items: BulkStudioImportItem[],
    mode: "merge" | "replace",
    dryRun: boolean,
  ): Promise<BulkStudioImportResult> {
    const previewItems: BulkStudioImportPreviewItem[] = [];
    let willCreate = 0;
    let willUpdate = 0;
    let errors = 0;

    // First pass: validate and compute preview
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const validationErrors: string[] = [];
      const missingDependencies: string[] = [];
      let existingStudio: Studio | null = null;
      let action: "create" | "update" = "create";

      // Check if updating existing studio
      if (item.id) {
        try {
          existingStudio = await studiosService.findById(item.id);
          action = "update";
        } catch {
          validationErrors.push(`Studio with id ${item.id} not found`);
        }
      } else {
        // Check if studio with same name exists
        const existing = await db
          .select()
          .from(studiosTable)
          .where(eq(studiosTable.name, item.name))
          .limit(1)
          .then((rows) => rows[0] || null);

        if (existing) {
          existingStudio = {
            id: existing.id,
            name: existing.name,
            description: existing.description,
            profile_picture_path: existing.profilePicturePath,
            created_at: existing.createdAt.toISOString(),
            updated_at: existing.updatedAt.toISOString(),
          };
          action = "update";
        }
      }

      // Validate creator IDs exist
      if (item.link_creator_ids && item.link_creator_ids.length > 0) {
        for (const creatorId of item.link_creator_ids) {
          const creator = await db
            .select({ id: creatorsTable.id })
            .from(creatorsTable)
            .where(eq(creatorsTable.id, creatorId))
            .limit(1)
            .then((rows) => rows[0] || null);

          if (!creator) {
            missingDependencies.push(`Creator id ${creatorId} not found`);
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
      const changes: BulkStudioImportPreviewItem["changes"] = {};

      if (existingStudio) {
        if (existingStudio.name !== item.name) {
          changes.name = { from: existingStudio.name, to: item.name };
        }
        if (
          item.description !== undefined &&
          existingStudio.description !== (item.description ?? null)
        ) {
          changes.description = {
            from: existingStudio.description,
            to: item.description ?? null,
          };
        }
        if (item.profile_picture_url) {
          changes.profile_picture = { action: "set" };
        }

        // Compute social link changes
        if (item.social_links) {
          const existingLinks = await studiosSocialService.getSocialLinks(
            existingStudio.id,
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

        // Compute creator link changes
        if (item.link_creator_ids) {
          const existingCreators =
            await studiosRelationshipsService.getCreators(existingStudio.id);
          const existingCreatorIds = existingCreators.map((c) => c.id);
          const add = item.link_creator_ids.filter(
            (id) => !existingCreatorIds.includes(id),
          ).length;
          const remove =
            mode === "replace"
              ? existingCreatorIds.filter(
                  (id) => !item.link_creator_ids!.includes(id),
                ).length
              : undefined;

          if (add > 0 || (remove && remove > 0)) {
            changes.creators = { add, remove };
          }
        }

        // Compute video link changes
        if (item.link_video_ids) {
          const existingVideos = await studiosRelationshipsService.getVideos(
            existingStudio.id,
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
        // New studio
        changes.name = { from: null, to: item.name };
        if (item.description) {
          changes.description = { from: null, to: item.description };
        }
        if (item.profile_picture_url) {
          changes.profile_picture = { action: "set" };
        }
        if (item.social_links && item.social_links.length > 0) {
          changes.social_links = { add: item.social_links.length, update: 0 };
        }
        if (item.link_creator_ids && item.link_creator_ids.length > 0) {
          changes.creators = { add: item.link_creator_ids.length };
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
        resolved_id: existingStudio?.id ?? null,
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
        let studioId: number;

        if (preview.action === "create") {
          const studio = await studiosService.create({
            name: item.name,
            description: item.description,
          });
          studioId = studio.id;
          preview.resolved_id = studioId;
        } else {
          studioId = preview.resolved_id!;
          if (
            preview.changes.name ||
            preview.changes.description !== undefined
          ) {
            await studiosService.update(studioId, {
              name: preview.changes.name?.to ?? undefined,
              description: item.description,
            });
          }
        }

        // Set profile picture from URL
        if (item.profile_picture_url) {
          try {
            await studiosSocialService.setPictureFromUrl(
              studioId,
              item.profile_picture_url,
            );
          } catch (error: any) {
            logger.warn(
              { error, studioId, url: item.profile_picture_url },
              "Failed to set profile picture from URL",
            );
          }
        }

        // Handle social links
        if (item.social_links && item.social_links.length > 0) {
          if (mode === "replace") {
            const existing =
              await studiosSocialService.getSocialLinks(studioId);
            for (const el of existing) {
              if (
                !item.social_links.some(
                  (sl) => sl.platform_name === el.platform_name,
                )
              ) {
                await studiosSocialService.deleteSocialLink(el.id);
              }
            }
          }
          await studiosSocialService.bulkUpsertSocialLinks(
            studioId,
            item.social_links,
          );
        }

        // Handle creator links
        if (item.link_creator_ids && item.link_creator_ids.length > 0) {
          if (mode === "replace") {
            const existingCreators =
              await studiosRelationshipsService.getCreators(studioId);
            for (const c of existingCreators) {
              if (!item.link_creator_ids.includes(c.id)) {
                await studiosRelationshipsService.unlinkCreator(studioId, c.id);
              }
            }
          }
          for (const creatorId of item.link_creator_ids) {
            try {
              await studiosRelationshipsService.linkCreator(
                studioId,
                creatorId,
              );
            } catch {
              // Ignore duplicates
            }
          }
        }

        // Handle video links
        if (item.link_video_ids && item.link_video_ids.length > 0) {
          if (mode === "replace") {
            const existingVideos =
              await studiosRelationshipsService.getVideos(studioId);
            for (const v of existingVideos) {
              if (!item.link_video_ids.includes(v.id)) {
                await studiosRelationshipsService.unlinkVideo(studioId, v.id);
              }
            }
          }
          for (const videoId of item.link_video_ids) {
            try {
              await studiosRelationshipsService.linkVideo(studioId, videoId);
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

export const studiosBulkService = new StudiosBulkService();
