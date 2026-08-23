import { existsSync } from "fs";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  demoSchema,
  getDemoDatabase,
  removeDemoRuntimeAsset,
  resolveDemoAssetPath,
  withDemoTransaction,
} from "@/database/demo";
import { NotFoundError } from "@/utils/errors";
import { studioAssignmentDemoService } from "@/modules/studios/studio-assignment.demo.service";

const {
  demoCreatorsTable,
  demoArtworkAssetsTable,
  demoFavoritesTable,
  demoResourcesTable,
  demoStoryboardsTable,
  demoStudiosTable,
  demoTagsTable,
  demoThumbnailsTable,
  demoVideoCreatorsTable,
  demoVideosTable,
  demoVideoStudiosTable,
  demoVideoTagsTable,
} = demoSchema;

type RelationshipKind = "creators" | "studios" | "tags";
type BulkAction = "add" | "remove" | "replace";

type DemoVideoUpdate = {
  title?: string | null;
  description?: string | null;
  themes?: string | null;
};

type DemoMetadata = {
  video_id: number;
  key: string;
  value: string;
  created_at: string;
  updated_at: string;
};

type DemoResourceRow = {
  kind: string;
  id: string;
  payloadJson: string;
};

function now(): string {
  return new Date().toISOString();
}

function metadataId(videoId: number, key: string): string {
  return `${videoId}:${key}`;
}

function parseMetadata(payload: string): DemoMetadata {
  return JSON.parse(payload) as DemoMetadata;
}

function parseResourcePayload(payload: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(payload);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * SQLite-backed demo behavior for catalog endpoints that previously either
 * returned no-op responses or fell through to the personal PostgreSQL library.
 * This adapter is intentionally synchronous to match bun:sqlite semantics.
 */
export class VideosDemoService {
  private ensureVideo(videoId: number): void {
    const video = getDemoDatabase()
      .select({ id: demoVideosTable.id })
      .from(demoVideosTable)
      .where(eq(demoVideosTable.id, videoId))
      .get();
    if (!video) throw new NotFoundError(`Video not found with id: ${videoId}`);
  }

  update(videoId: number, input: DemoVideoUpdate) {
    this.ensureVideo(videoId);
    const values = {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.description !== undefined
        ? { description: input.description }
        : {}),
      ...(input.themes !== undefined ? { themes: input.themes } : {}),
      updatedAt: now(),
    };
    getDemoDatabase()
      .update(demoVideosTable)
      .set(values)
      .where(eq(demoVideosTable.id, videoId))
      .run();
    return getDemoDatabase()
      .select()
      .from(demoVideosTable)
      .where(eq(demoVideosTable.id, videoId))
      .get()!;
  }

  delete(videoId: number): void {
    this.ensureVideo(videoId);
    getDemoDatabase()
      .delete(demoVideosTable)
      .where(eq(demoVideosTable.id, videoId))
      .run();
  }

  getMetadata(videoId: number): DemoMetadata[] {
    this.ensureVideo(videoId);
    return getDemoDatabase()
      .select({ payload: demoResourcesTable.payloadJson })
      .from(demoResourcesTable)
      .where(
        and(
          eq(demoResourcesTable.kind, "video-metadata"),
          sql`${demoResourcesTable.id} LIKE ${`${videoId}:%`}`
        )
      )
      .orderBy(asc(demoResourcesTable.id))
      .all()
      .map((row) => parseMetadata(row.payload));
  }

  setMetadata(videoId: number, key: string, value: string): DemoMetadata {
    this.ensureVideo(videoId);
    const id = metadataId(videoId, key);
    const existing = getDemoDatabase()
      .select({ payload: demoResourcesTable.payloadJson })
      .from(demoResourcesTable)
      .where(
        and(
          eq(demoResourcesTable.kind, "video-metadata"),
          eq(demoResourcesTable.id, id)
        )
      )
      .get();
    const timestamp = now();
    const previous = existing ? parseMetadata(existing.payload) : null;
    const metadata: DemoMetadata = {
      video_id: videoId,
      key,
      value,
      created_at: previous?.created_at ?? timestamp,
      updated_at: timestamp,
    };
    getDemoDatabase()
      .insert(demoResourcesTable)
      .values({
        kind: "video-metadata",
        id,
        payloadJson: JSON.stringify(metadata),
        createdAt: metadata.created_at,
        updatedAt: timestamp,
      })
      .onConflictDoUpdate({
        target: [demoResourcesTable.kind, demoResourcesTable.id],
        set: { payloadJson: JSON.stringify(metadata), updatedAt: timestamp },
      })
      .run();
    return metadata;
  }

  deleteMetadata(videoId: number, key: string): void {
    this.ensureVideo(videoId);
    getDemoDatabase()
      .delete(demoResourcesTable)
      .where(
        and(
          eq(demoResourcesTable.kind, "video-metadata"),
          eq(demoResourcesTable.id, metadataId(videoId, key))
        )
      )
      .run();
  }

  private relationship(kind: RelationshipKind) {
    switch (kind) {
      case "creators":
        return {
          relation: demoVideoCreatorsTable,
          videoColumn: demoVideoCreatorsTable.videoId,
          targetColumn: demoVideoCreatorsTable.creatorId,
          target: demoCreatorsTable,
        } as const;
      case "studios":
        return {
          relation: demoVideoStudiosTable,
          videoColumn: demoVideoStudiosTable.videoId,
          targetColumn: demoVideoStudiosTable.studioId,
          target: demoStudiosTable,
        } as const;
      case "tags":
        return {
          relation: demoVideoTagsTable,
          videoColumn: demoVideoTagsTable.videoId,
          targetColumn: demoVideoTagsTable.tagId,
          target: demoTagsTable,
        } as const;
    }
  }

  updateRelationships(
    videoIds: number[],
    kind: RelationshipKind,
    targetIds: number[],
    action: BulkAction
  ): void {
    if (videoIds.length === 0) return;
    if (kind === "studios") {
      if (action === "add") studioAssignmentDemoService.linkMany(videoIds, targetIds);
      else if (action === "remove") studioAssignmentDemoService.unlinkMany(videoIds, targetIds);
      else studioAssignmentDemoService.replaceMany(videoIds, targetIds);
      return;
    }
    const spec = this.relationship(kind);
    withDemoTransaction(() => {
      const existingVideos = getDemoDatabase()
        .select({ id: demoVideosTable.id })
        .from(demoVideosTable)
        .where(inArray(demoVideosTable.id, videoIds))
        .all();
      if (existingVideos.length !== new Set(videoIds).size) {
        throw new NotFoundError("One or more demo videos were not found");
      }

      if (action === "replace") {
        getDemoDatabase()
          .delete(spec.relation)
          .where(inArray(spec.videoColumn, videoIds))
          .run();
      } else if (action === "remove" && targetIds.length > 0) {
        getDemoDatabase()
          .delete(spec.relation)
          .where(
            and(
              inArray(spec.videoColumn, videoIds),
              inArray(spec.targetColumn, targetIds)
            )
          )
          .run();
      }

      if ((action === "add" || action === "replace") && targetIds.length > 0) {
        const values = videoIds.flatMap((videoId) =>
          targetIds.map((targetId) =>
            kind === "creators"
              ? { videoId, creatorId: targetId }
              : { videoId, tagId: targetId }
          )
        );
        getDemoDatabase()
          .insert(spec.relation)
          .values(values as never)
          .onConflictDoNothing()
          .run();
      }
    });
  }

  bulkUpdateFavorites(
    userId: number,
    videoIds: number[],
    action: "add" | "remove"
  ): void {
    if (videoIds.length === 0) return;
    if (action === "remove") {
      getDemoDatabase()
        .delete(demoFavoritesTable)
        .where(
          and(
            eq(demoFavoritesTable.userId, userId),
            inArray(demoFavoritesTable.videoId, videoIds)
          )
        )
        .run();
      return;
    }
    const timestamp = now();
    getDemoDatabase()
      .insert(demoFavoritesTable)
      .values(
        videoIds.map((videoId) => ({ userId, videoId, addedAt: timestamp }))
      )
      .onConflictDoNothing()
      .run();
  }

  getDuplicates() {
    const groups = getDemoDatabase()
      .select({
        fileHash: demoVideosTable.fileHash,
        duplicateCount: sql<number>`count(*)`,
        totalSizeBytes: sql<number>`sum(${demoVideosTable.fileSizeBytes})`,
      })
      .from(demoVideosTable)
      .where(sql`${demoVideosTable.fileHash} is not null`)
      .groupBy(demoVideosTable.fileHash)
      .having(sql`count(*) > 1`)
      .all();

    return groups.map((group) => ({
      file_hash: group.fileHash!,
      count: Number(group.duplicateCount),
      total_size_bytes: String(Number(group.totalSizeBytes)),
      videos: getDemoDatabase()
        .select()
        .from(demoVideosTable)
        .where(eq(demoVideosTable.fileHash, group.fileHash!))
        .all()
        .map((video) => ({
          id: video.id,
          file_name: video.fileName,
          file_path: video.filePath,
          file_size_bytes: video.fileSizeBytes,
          indexed_at: video.indexedAt,
        })),
    }));
  }

  listUnavailable(options: {
    page: number;
    limit: number;
    directoryId?: number;
  }) {
    const where =
      options.directoryId === undefined
        ? eq(demoVideosTable.isAvailable, false)
        : and(
            eq(demoVideosTable.isAvailable, false),
            eq(demoVideosTable.directoryId, options.directoryId)
          );
    const total = Number(
      getDemoDatabase()
        .select({ count: sql<number>`count(*)` })
        .from(demoVideosTable)
        .where(where)
        .get()?.count ?? 0
    );
    const rows = getDemoDatabase()
      .select()
      .from(demoVideosTable)
      .where(where)
      .limit(options.limit)
      .offset((options.page - 1) * options.limit)
      .all();
    const data = rows.map((video) => {
      const thumbnail = getDemoDatabase()
        .select()
        .from(demoThumbnailsTable)
        .where(eq(demoThumbnailsTable.videoId, video.id))
        .get();
      const storyboard = getDemoDatabase()
        .select()
        .from(demoStoryboardsTable)
        .where(eq(demoStoryboardsTable.videoId, video.id))
        .get();
      const artwork = getDemoDatabase()
        .select()
        .from(demoArtworkAssetsTable)
        .where(eq(demoArtworkAssetsTable.videoId, video.id))
        .all();
      const artworkBytes = artwork.reduce(
        (sum, asset) => sum + asset.fileSizeBytes,
        0
      );
      return {
        id: video.id,
        file_path: video.filePath,
        file_name: video.fileName,
        directory_id: video.directoryId,
        directory_path: null,
        last_verified_at: video.lastVerifiedAt,
        thumbnail_url: thumbnail
          ? `/api/thumbnails/${thumbnail.videoId}/image`
          : null,
        artifacts: {
          thumbnail: Boolean(thumbnail),
          storyboard: Boolean(storyboard),
          face_count: 0,
          artwork_count: artwork.length,
          reclaimable_bytes:
            (thumbnail?.fileSizeBytes ?? 0) +
            (storyboard?.spriteSizeBytes ?? 0) +
            artworkBytes,
        },
      };
    });
    return {
      data,
      pagination: {
        page: options.page,
        limit: options.limit,
        total,
        totalPages: Math.ceil(total / options.limit),
      },
    };
  }

  verifyAvailability(options: { directoryId?: number; videoId?: number } = {}) {
    const conditions = [];
    if (options.directoryId !== undefined) {
      conditions.push(eq(demoVideosTable.directoryId, options.directoryId));
    }
    if (options.videoId !== undefined) {
      conditions.push(eq(demoVideosTable.id, options.videoId));
    }
    const videos = getDemoDatabase()
      .select({
        id: demoVideosTable.id,
        filePath: demoVideosTable.filePath,
        isAvailable: demoVideosTable.isAvailable,
      })
      .from(demoVideosTable)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .all();
    let nowAvailable = 0;
    let stillMissing = 0;
    const verifiedAt = now();
    withDemoTransaction(() => {
      for (const video of videos) {
        const available = existsSync(
          resolveDemoAssetPath(video.filePath, { mustExist: false })
        );
        if (available) nowAvailable += 1;
        else stillMissing += 1;
        getDemoDatabase()
          .update(demoVideosTable)
          .set({
            isAvailable: available,
            lastVerifiedAt: verifiedAt,
            updatedAt: verifiedAt,
          })
          .where(eq(demoVideosTable.id, video.id))
          .run();
      }
    });
    return {
      checked: videos.length,
      now_available: nowAvailable,
      still_missing: stillMissing,
    };
  }

  purgeUnavailable(input: { ids?: number[]; directoryId?: number }) {
    const conditions = [eq(demoVideosTable.isAvailable, false)];
    if (input.ids?.length)
      conditions.push(inArray(demoVideosTable.id, input.ids));
    if (input.directoryId !== undefined) {
      conditions.push(eq(demoVideosTable.directoryId, input.directoryId));
    }
    const targets = getDemoDatabase()
      .select({ id: demoVideosTable.id })
      .from(demoVideosTable)
      .where(and(...conditions))
      .all();
    const ids = targets.map((target) => target.id);
    if (ids.length > 0) {
      const thumbnailPaths = getDemoDatabase()
        .select({ filePath: demoThumbnailsTable.filePath })
        .from(demoThumbnailsTable)
        .where(inArray(demoThumbnailsTable.videoId, ids))
        .all()
        .map((row) => row.filePath);
      const storyboardPaths = getDemoDatabase()
        .select({
          spritePath: demoStoryboardsTable.spritePath,
          vttPath: demoStoryboardsTable.vttPath,
        })
        .from(demoStoryboardsTable)
        .where(inArray(demoStoryboardsTable.videoId, ids))
        .all()
        .flatMap((row) => [row.spritePath, row.vttPath]);
      const artworkPaths = getDemoDatabase()
        .select({ filePath: demoArtworkAssetsTable.filePath })
        .from(demoArtworkAssetsTable)
        .where(inArray(demoArtworkAssetsTable.videoId, ids))
        .all()
        .map((row) => row.filePath);

      const faceKinds = [
        "face-detection",
        "face-extraction-job",
        "face-image",
        "face-embedding",
      ];
      const faceResources = getDemoDatabase()
        .select({
          kind: demoResourcesTable.kind,
          id: demoResourcesTable.id,
          payloadJson: demoResourcesTable.payloadJson,
        })
        .from(demoResourcesTable)
        .where(inArray(demoResourcesTable.kind, faceKinds))
        .all() as DemoResourceRow[];
      const videoIds = new Set(ids);
      const parsedResources = faceResources.map((row) => ({
        row,
        payload: parseResourcePayload(row.payloadJson),
      }));
      const detectionIds = new Set(
        parsedResources
          .filter(
            ({ row, payload }) =>
              row.kind === "face-detection" &&
              videoIds.has(Number(payload.videoId))
          )
          .map(({ row }) => row.id)
      );
      const resourcesToDelete = parsedResources.filter(({ row, payload }) => {
        if (row.kind === "face-detection") return detectionIds.has(row.id);
        if (row.kind === "face-image") {
          return detectionIds.has(String(payload.detectionId));
        }
        if (row.kind === "face-extraction-job") {
          return videoIds.has(Number(payload.videoId));
        }
        return (
          row.kind === "face-embedding" &&
          videoIds.has(Number(payload.sourceVideoId))
        );
      });
      const facePaths = resourcesToDelete.flatMap(({ row, payload }) => {
        if (row.kind === "face-image" && typeof payload.filePath === "string") {
          return [payload.filePath];
        }
        if (
          row.kind === "face-embedding" &&
          typeof payload.thumbnailPath === "string"
        ) {
          return [payload.thumbnailPath];
        }
        return [];
      });

      withDemoTransaction(() => {
        for (const { row } of resourcesToDelete) {
          getDemoDatabase()
            .delete(demoResourcesTable)
            .where(
              and(
                eq(demoResourcesTable.kind, row.kind),
                eq(demoResourcesTable.id, row.id)
              )
            )
            .run();
        }
        getDemoDatabase()
          .delete(demoVideosTable)
          .where(inArray(demoVideosTable.id, ids))
          .run();
      });

      for (const path of [
        ...thumbnailPaths,
        ...storyboardPaths,
        ...artworkPaths,
        ...facePaths,
      ]) {
        removeDemoRuntimeAsset(path);
      }
    }
    return { deleted_count: ids.length, deleted_ids: ids };
  }
}

export const videosDemoService = new VideosDemoService();
