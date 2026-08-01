import {
  demoRepository,
  getDemoSqlite,
  withDemoTransaction,
} from "@/database/demo";
import type {
  BulkCreatorImportItem,
  BulkImportPreviewItem,
  BulkImportResult,
} from "./creators.types";
import { creatorsDemoService } from "./creators.demo.service";

/** Bulk creator import constrained to the normalized demo SQLite services. */
export class CreatorsBulkDemoService {
  async bulkImport(
    items: BulkCreatorImportItem[],
    mode: "merge" | "replace",
    dryRun: boolean
  ): Promise<BulkImportResult> {
    const previewItems: BulkImportPreviewItem[] = [];
    let willCreate = 0;
    let willUpdate = 0;
    let errors = 0;
    const seenIds = new Set<number>();
    const seenNames = new Set<string>();

    for (const [index, item] of items.entries()) {
      const validationErrors: string[] = [];
      const missingDependencies: string[] = [];
      const normalizedName = item.name.trim().toLocaleLowerCase();
      if (item.id && seenIds.has(item.id)) {
        validationErrors.push(`Duplicate creator id ${item.id} in batch`);
      }
      if (seenNames.has(normalizedName)) {
        validationErrors.push(`Duplicate creator name "${item.name}" in batch`);
      }
      if (item.id) seenIds.add(item.id);
      seenNames.add(normalizedName);
      let existing = item.id
        ? this.creator(item.id)
        : this.creatorByName(item.name);
      if (item.id && !existing) {
        validationErrors.push(`Creator with id ${item.id} not found`);
      }
      for (const videoId of item.link_video_ids ?? []) {
        if (!this.videoExists(videoId)) {
          missingDependencies.push(`Video id ${videoId} not found`);
        }
      }
      const action = existing ? "update" : "create";
      const changes: BulkImportPreviewItem["changes"] = {};
      if (!existing) changes.name = { from: null, to: item.name };
      else {
        if (existing.name !== item.name) {
          changes.name = { from: existing.name, to: item.name };
        }
        if (
          item.description !== undefined &&
          existing.description !== (item.description ?? null)
        ) {
          changes.description = {
            from: existing.description,
            to: item.description ?? null,
          };
        }
      }
      if (item.profile_picture_url) changes.profile_picture = { action: "set" };
      if (item.platforms?.length)
        changes.platforms = { add: item.platforms.length, update: 0 };
      if (item.social_links?.length)
        changes.social_links = { add: item.social_links.length, update: 0 };
      if (item.aliases?.length)
        changes.aliases = { add: item.aliases.length, update: 0 };
      if (item.link_video_ids?.length)
        changes.videos = { add: item.link_video_ids.length };

      const hasErrors =
        validationErrors.length > 0 || missingDependencies.length > 0;
      if (hasErrors) errors += 1;
      else if (action === "create") willCreate += 1;
      else willUpdate += 1;
      previewItems.push({
        index,
        action,
        resolved_id: existing?.id ?? null,
        name: item.name,
        validation_errors: validationErrors,
        changes,
        missing_dependencies: missingDependencies,
      });
    }

    if (!dryRun && errors === 0) {
      withDemoTransaction(() => {
        for (const [index, item] of items.entries()) {
          const preview = previewItems[index]!;
          let creatorId = preview.resolved_id;
          if (creatorId === null) {
            creatorId = creatorsDemoService.create({
              name: item.name,
              description: item.description,
            }).id;
            preview.resolved_id = creatorId;
          } else {
            creatorsDemoService.update(creatorId, {
              name: item.name,
              description: item.description,
            });
          }

          this.syncPlatforms(creatorId, item, mode);
          this.syncSocialLinks(creatorId, item, mode);
          this.syncAliases(creatorId, item, mode);
          this.syncVideos(creatorId, item, mode);
          // Remote picture URLs are deliberately represented in the preview but
          // never fetched in demo mode.
        }
      });
    }

    return {
      success: errors === 0,
      dry_run: dryRun,
      items: previewItems,
      summary: { will_create: willCreate, will_update: willUpdate, errors },
    };
  }

  private creator(id: number) {
    try {
      return creatorsDemoService.findById(id);
    } catch {
      return null;
    }
  }

  private creatorByName(name: string) {
    return (
      demoRepository
        .getCreators({ search: name, limit: 10_000 })
        .data.find((creator: any) => creator.name === name) ?? null
    );
  }

  private videoExists(id: number): boolean {
    try {
      return Boolean(demoRepository.getVideoById(id));
    } catch {
      return false;
    }
  }

  private syncPlatforms(
    creatorId: number,
    item: BulkCreatorImportItem,
    mode: "merge" | "replace"
  ): void {
    if (item.platforms === undefined) return;
    const existing = creatorsDemoService.getPlatforms(creatorId);
    if (mode === "replace") {
      for (const current of existing) {
        if (
          !item.platforms.some(
            (candidate) =>
              candidate.platform_id === current.platform_id &&
              candidate.username === current.username
          )
        ) {
          creatorsDemoService.deletePlatform(creatorId, current.id);
        }
      }
    }
    for (const candidate of item.platforms) {
      const current = creatorsDemoService
        .getPlatforms(creatorId)
        .find(
          (value) =>
            value.platform_id === candidate.platform_id &&
            value.username === candidate.username
        );
      if (current)
        creatorsDemoService.updatePlatform(creatorId, current.id, candidate);
      else creatorsDemoService.addPlatform(creatorId, candidate);
    }
  }

  private syncSocialLinks(
    creatorId: number,
    item: BulkCreatorImportItem,
    mode: "merge" | "replace"
  ): void {
    if (item.social_links === undefined) return;
    const existing = creatorsDemoService.getSocialLinks(creatorId);
    if (mode === "replace") {
      for (const current of existing) {
        if (
          !item.social_links.some(
            (candidate) => candidate.platform_name === current.platform_name
          )
        ) {
          creatorsDemoService.deleteSocialLink(creatorId, current.id);
        }
      }
    }
    for (const candidate of item.social_links) {
      const current = creatorsDemoService
        .getSocialLinks(creatorId)
        .find((value) => value.platform_name === candidate.platform_name);
      if (current)
        creatorsDemoService.updateSocialLink(creatorId, current.id, candidate);
      else creatorsDemoService.addSocialLink(creatorId, candidate);
    }
  }

  private syncAliases(
    creatorId: number,
    item: BulkCreatorImportItem,
    mode: "merge" | "replace"
  ): void {
    if (item.aliases === undefined) return;
    const existing = creatorsDemoService.getAliases(creatorId);
    if (mode === "replace") {
      for (const current of existing) {
        if (
          !item.aliases.some((candidate) => candidate.name === current.name)
        ) {
          creatorsDemoService.deleteAlias(creatorId, current.id);
        }
      }
    }
    for (const candidate of item.aliases) {
      const current = creatorsDemoService
        .getAliases(creatorId)
        .find((value) => value.name === candidate.name);
      if (current)
        creatorsDemoService.updateAlias(creatorId, current.id, candidate);
      else {
        creatorsDemoService.addAlias(creatorId, {
          name: candidate.name,
          note: candidate.note ?? undefined,
        });
      }
    }
  }

  private syncVideos(
    creatorId: number,
    item: BulkCreatorImportItem,
    mode: "merge" | "replace"
  ): void {
    if (item.link_video_ids === undefined) return;
    const existingIds = new Set(
      demoRepository
        .getVideos({ creatorIds: [creatorId], limit: 10_000 })
        .data.map((video: any) => video.id)
    );
    if (mode === "replace") {
      for (const videoId of existingIds) {
        if (!item.link_video_ids.includes(videoId)) {
          getDemoSqlite().run(
            "DELETE FROM demo_video_creators WHERE video_id = ? AND creator_id = ?",
            [videoId, creatorId]
          );
        }
      }
    }
    for (const videoId of item.link_video_ids) {
      getDemoSqlite().run(
        "INSERT OR IGNORE INTO demo_video_creators (video_id, creator_id) VALUES (?, ?)",
        [videoId, creatorId]
      );
    }
  }
}

export const creatorsBulkDemoService = new CreatorsBulkDemoService();
