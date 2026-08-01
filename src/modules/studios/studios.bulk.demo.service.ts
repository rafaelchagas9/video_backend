import { demoRepository, withDemoTransaction } from "@/database/demo";
import type {
  BulkStudioImportItem,
  BulkStudioImportPreviewItem,
  BulkStudioImportResult,
} from "./studios.types";
import { studiosDemoService } from "./studios.demo.service";

/** Bulk studio import constrained to the normalized demo SQLite services. */
export class StudiosBulkDemoService {
  async bulkImport(
    items: BulkStudioImportItem[],
    mode: "merge" | "replace",
    dryRun: boolean
  ): Promise<BulkStudioImportResult> {
    const previewItems: BulkStudioImportPreviewItem[] = [];
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
        validationErrors.push(`Duplicate studio id ${item.id} in batch`);
      }
      if (seenNames.has(normalizedName)) {
        validationErrors.push(`Duplicate studio name "${item.name}" in batch`);
      }
      if (item.id) seenIds.add(item.id);
      seenNames.add(normalizedName);
      const existing = item.id
        ? this.studio(item.id)
        : this.studioByName(item.name);
      if (item.id && !existing)
        validationErrors.push(`Studio with id ${item.id} not found`);
      for (const creatorId of item.link_creator_ids ?? []) {
        if (!this.creatorExists(creatorId))
          missingDependencies.push(`Creator id ${creatorId} not found`);
      }
      for (const videoId of item.link_video_ids ?? []) {
        if (!this.videoExists(videoId))
          missingDependencies.push(`Video id ${videoId} not found`);
      }
      const action = existing ? "update" : "create";
      const changes: BulkStudioImportPreviewItem["changes"] = {};
      if (!existing) changes.name = { from: null, to: item.name };
      else {
        if (existing.name !== item.name)
          changes.name = { from: existing.name, to: item.name };
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
      if (item.social_links?.length)
        changes.social_links = { add: item.social_links.length, update: 0 };
      if (item.link_creator_ids?.length)
        changes.creators = { add: item.link_creator_ids.length };
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
          let studioId = preview.resolved_id;
          if (studioId === null) {
            studioId = studiosDemoService.create({
              name: item.name,
              description: item.description,
            }).id;
            preview.resolved_id = studioId;
          } else {
            studiosDemoService.update(studioId, {
              name: item.name,
              description: item.description,
            });
          }
          this.syncSocialLinks(studioId, item, mode);
          this.syncCreators(studioId, item, mode);
          this.syncVideos(studioId, item, mode);
          // Remote picture URLs are deliberately previewed but never fetched.
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

  private studio(id: number) {
    try {
      return studiosDemoService.findById(id);
    } catch {
      return null;
    }
  }

  private studioByName(name: string) {
    return (
      demoRepository
        .getStudios({ search: name, limit: 10_000 })
        .data.find((studio: any) => studio.name === name) ?? null
    );
  }

  private creatorExists(id: number): boolean {
    try {
      return Boolean(demoRepository.getCreatorById(id));
    } catch {
      return false;
    }
  }

  private videoExists(id: number): boolean {
    try {
      return Boolean(demoRepository.getVideoById(id));
    } catch {
      return false;
    }
  }

  private syncSocialLinks(
    studioId: number,
    item: BulkStudioImportItem,
    mode: "merge" | "replace"
  ): void {
    if (item.social_links === undefined) return;
    const existing = studiosDemoService.listSocialLinks(studioId);
    if (mode === "replace") {
      for (const current of existing) {
        if (
          !item.social_links.some(
            (candidate) => candidate.platform_name === current.platform_name
          )
        ) {
          studiosDemoService.deleteSocialLink(studioId, current.id);
        }
      }
    }
    for (const candidate of item.social_links) {
      const current = studiosDemoService
        .listSocialLinks(studioId)
        .find((value) => value.platform_name === candidate.platform_name);
      if (current)
        studiosDemoService.updateSocialLink(studioId, current.id, candidate);
      else studiosDemoService.addSocialLink(studioId, candidate);
    }
  }

  private syncCreators(
    studioId: number,
    item: BulkStudioImportItem,
    mode: "merge" | "replace"
  ): void {
    if (item.link_creator_ids === undefined) return;
    const existing = new Set(
      studiosDemoService.getCreators(studioId).map((creator) => creator.id)
    );
    if (mode === "replace") {
      for (const creatorId of existing) {
        if (!item.link_creator_ids.includes(creatorId))
          studiosDemoService.unlinkCreator(studioId, creatorId);
      }
    }
    for (const creatorId of item.link_creator_ids) {
      if (
        !studiosDemoService
          .getCreators(studioId)
          .some((creator) => creator.id === creatorId)
      ) {
        studiosDemoService.linkCreator(studioId, creatorId);
      }
    }
  }

  private syncVideos(
    studioId: number,
    item: BulkStudioImportItem,
    mode: "merge" | "replace"
  ): void {
    if (item.link_video_ids === undefined) return;
    const existing = new Set(studiosDemoService.getVideoIds(studioId));
    if (mode === "replace") {
      for (const videoId of existing) {
        if (!item.link_video_ids.includes(videoId))
          studiosDemoService.unlinkVideo(studioId, videoId);
      }
    }
    for (const videoId of item.link_video_ids) {
      if (!studiosDemoService.getVideoIds(studioId).includes(videoId))
        studiosDemoService.linkVideo(studioId, videoId);
    }
  }
}

export const studiosBulkDemoService = new StudiosBulkDemoService();
