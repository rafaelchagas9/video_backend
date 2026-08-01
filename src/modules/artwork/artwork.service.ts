import { unlink } from "fs/promises";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/config/drizzle";
import { env } from "@/config/env";
import { API_PREFIX } from "@/config/constants";
import {
  artworkAssetsTable,
  videoArtworkTable,
  videoCollectionEntriesTable,
  videoCreatorsTable,
  videosTable,
} from "@/database/schema";
import { videosService } from "@/modules/videos/videos.service";
import { eventsService } from "@/modules/events/events.service";
import { createVideoEventContext } from "@/modules/events/events.types";
import { logger } from "@/utils/logger";
import { NotFoundError } from "@/utils/errors";
import { demoArtworkService } from "./artwork.demo.service";
import { demoMediaAssetsService } from "@/modules/media/demo-media-assets.service";
import { demoRepository } from "@/database/demo";
import {
  generateArtworkFiles,
  isArtworkTitleEligible,
} from "./artwork.processing";
import {
  ARTWORK_VARIANTS,
  RASTER_ARTWORK_VARIANTS,
  type ArtworkAsset,
  type ArtworkEffect,
  type ArtworkPalette,
  type ArtworkStatus,
  type ArtworkVariant,
  type BatchGenerateArtworkInput,
  type GenerateArtworkInput,
  type NormalizedPoint,
  type NormalizedRect,
  type StoredArtworkRequest,
  type VideoArtwork,
  type VideoArtworkSummary,
} from "./artwork.types";

interface ArtworkJob {
  videoId: number;
  request: StoredArtworkRequest;
  batch?: { total: number; completed: number };
}

type ArtworkAssetRow = typeof artworkAssetsTable.$inferSelect;

class ArtworkService {
  private queue: ArtworkJob[] = [];
  private processing = false;
  private pendingVideoIds = new Set<number>();
  private cancelledVideos = new Set<number>();

  private assetUrl(asset: { id: number; contentHash: string }): string {
    return `${API_PREFIX}/artwork/${asset.id}/image?h=${asset.contentHash}`;
  }

  private mapAsset(row: ArtworkAssetRow): ArtworkAsset {
    return {
      id: row.id,
      video_id: row.videoId,
      variant: row.variant as ArtworkVariant,
      url: this.assetUrl(row),
      width: row.width,
      height: row.height,
      file_size_bytes: row.fileSizeBytes,
      source_timestamp_seconds: row.sourceTimestampSeconds,
      crop: row.crop as NormalizedRect | null,
      focal_point: row.focalPoint as NormalizedPoint | null,
      safe_area: row.safeArea as NormalizedRect | null,
      bottom_luma: row.bottomLuma,
      thumbhash: row.thumbhash,
      effects: row.effects as ArtworkEffect[],
      generated_at: row.generatedAt.toISOString(),
    };
  }

  async getByVideoId(videoId: number): Promise<VideoArtwork> {
    if (env.DEMO_MODE) {
      return demoArtworkService.getByVideoId(videoId);
    }

    await videosService.findFilePathById(videoId);
    const [set, assets] = await Promise.all([
      db
        .select()
        .from(videoArtworkTable)
        .where(eq(videoArtworkTable.videoId, videoId))
        .limit(1)
        .then((rows) => rows[0] ?? null),
      db
        .select()
        .from(artworkAssetsTable)
        .where(eq(artworkAssetsTable.videoId, videoId)),
    ]);

    return {
      video_id: videoId,
      status: (set?.status as ArtworkStatus | undefined) ?? "absent",
      palette: (set?.palette as ArtworkPalette | null | undefined) ?? null,
      assets: assets.map((asset) => this.mapAsset(asset)),
      error: set?.error ?? null,
      generated_at: set?.generatedAt?.toISOString() ?? null,
    };
  }

  async getAssetById(id: number): Promise<ArtworkAssetRow> {
    if (env.DEMO_MODE) {
      return demoArtworkService.getAssetById(id);
    }
    const asset = await db
      .select()
      .from(artworkAssetsTable)
      .where(eq(artworkAssetsTable.id, id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!asset)
      throw new NotFoundError(`Artwork asset not found with id: ${id}`);
    return asset;
  }

  async getSummariesByVideoIds(
    videoIds: number[]
  ): Promise<Map<number, VideoArtworkSummary>> {
    const summaries = new Map<number, VideoArtworkSummary>();
    if (videoIds.length === 0) return summaries;
    if (env.DEMO_MODE) {
      return demoArtworkService.getSummariesByVideoIds(videoIds);
    }
    const [sets, assets] = await Promise.all([
      db
        .select()
        .from(videoArtworkTable)
        .where(inArray(videoArtworkTable.videoId, videoIds)),
      db
        .select()
        .from(artworkAssetsTable)
        .where(inArray(artworkAssetsTable.videoId, videoIds)),
    ]);
    const palettes = new Map(
      sets.map((set) => [
        set.videoId,
        (set.palette as ArtworkPalette | null | undefined) ?? null,
      ])
    );
    const grouped = new Map<number, ArtworkAssetRow[]>();
    for (const asset of assets) {
      const current = grouped.get(asset.videoId) ?? [];
      current.push(asset);
      grouped.set(asset.videoId, current);
    }
    for (const videoId of videoIds) {
      const videoAssets = grouped.get(videoId) ?? [];
      if (videoAssets.length === 0 && !palettes.has(videoId)) continue;
      const card =
        videoAssets.find((asset) => asset.variant === "card") ?? null;
      const hero =
        videoAssets.find((asset) => asset.variant === "hero") ?? null;
      const representative = card ?? hero ?? videoAssets[0] ?? null;
      const urls: VideoArtworkSummary["urls"] = {};
      for (const asset of videoAssets) {
        urls[asset.variant as ArtworkVariant] = this.assetUrl(asset);
      }
      summaries.set(videoId, {
        urls,
        palette: palettes.get(videoId) ?? null,
        focal_point:
          (representative?.focalPoint as NormalizedPoint | null | undefined) ??
          null,
        safe_area:
          (hero?.safeArea as NormalizedRect | null | undefined) ??
          (representative?.safeArea as NormalizedRect | null | undefined) ??
          null,
        bottom_luma: hero?.bottomLuma ?? representative?.bottomLuma ?? null,
        thumbhash: representative?.thumbhash ?? null,
      });
    }
    return summaries;
  }

  private normalizeRequest(input: GenerateArtworkInput): StoredArtworkRequest {
    const requested = input.variants ?? [...RASTER_ARTWORK_VARIANTS, "title"];
    const variants = requested.filter((variant): variant is ArtworkVariant =>
      ARTWORK_VARIANTS.includes(variant)
    );
    return {
      variants: [...new Set(variants)],
      force: input.force ?? false,
      ...(input.timestamp_seconds !== undefined
        ? { timestamp_seconds: input.timestamp_seconds }
        : {}),
      ...(input.effects !== undefined ? { effects: input.effects } : {}),
    };
  }

  private requestForVideo(
    request: StoredArtworkRequest,
    video: { title: string | null; fileName?: string; file_name?: string }
  ): StoredArtworkRequest {
    const fileName = video.file_name ?? video.fileName ?? "";
    const displayTitle =
      video.title?.trim() || fileName.replace(/\.[^.]+$/, "");
    return {
      ...request,
      variants: request.variants.filter(
        (variant) => variant !== "title" || isArtworkTitleEligible(displayTitle)
      ),
    };
  }

  async requestGeneration(
    videoId: number,
    input: GenerateArtworkInput
  ): Promise<VideoArtwork> {
    if (env.DEMO_MODE) {
      demoMediaAssetsService.generateArtwork(videoId, input);
      return this.getByVideoId(videoId);
    }
    const video = await videosService.findById(videoId);
    this.cancelledVideos.delete(videoId);
    const request = this.requestForVideo(this.normalizeRequest(input), video);
    if (request.variants.length === 0) return this.getByVideoId(videoId);

    const existing = await db
      .select({ variant: artworkAssetsTable.variant })
      .from(artworkAssetsTable)
      .where(eq(artworkAssetsTable.videoId, videoId));
    const existingVariants = new Set(existing.map((asset) => asset.variant));
    if (!request.force) {
      request.variants = request.variants.filter(
        (variant) => !existingVariants.has(variant)
      );
    }
    if (request.variants.length === 0 || this.pendingVideoIds.has(videoId)) {
      return this.getByVideoId(videoId);
    }

    await db
      .insert(videoArtworkTable)
      .values({
        videoId,
        status: "generating",
        error: null,
        request,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: videoArtworkTable.videoId,
        set: {
          status: "generating",
          error: null,
          request,
          updatedAt: new Date(),
        },
      });
    this.enqueue({ videoId, request });
    return this.getByVideoId(videoId);
  }

  async requestBatch(input: BatchGenerateArtworkInput): Promise<number[]> {
    if (env.DEMO_MODE) {
      let videos = input.video_ids
        ? input.video_ids.map((id) => demoRepository.getVideoById(id))
        : demoRepository.getVideos({
            creatorIds: input.filter?.creator_id
              ? [input.filter.creator_id]
              : undefined,
            limit: 10_000,
          }).data;
      if (input.filter?.collection_id)
        videos = videos.filter(
          (video: any) => video.collection?.id === input.filter!.collection_id
        );
      if (input.filter?.missing_only)
        videos = videos.filter(
          (video: any) =>
            demoArtworkService.getByVideoId(video.id).status === "absent"
        );
      for (const video of videos)
        demoMediaAssetsService.generateArtwork(video.id, input);
      return videos.map((video: any) => video.id);
    }
    const request = this.normalizeRequest(input);
    if (request.variants.length === 0) return [];
    let rows: Array<{ id: number; title: string | null; fileName: string }>;
    if (input.video_ids) {
      rows = await db
        .select({
          id: videosTable.id,
          title: videosTable.title,
          fileName: videosTable.fileName,
        })
        .from(videosTable)
        .where(inArray(videosTable.id, input.video_ids));
    } else if (input.filter?.collection_id) {
      rows = await db
        .selectDistinct({
          id: videosTable.id,
          title: videosTable.title,
          fileName: videosTable.fileName,
        })
        .from(videosTable)
        .innerJoin(
          videoCollectionEntriesTable,
          eq(videoCollectionEntriesTable.videoId, videosTable.id)
        )
        .where(
          eq(
            videoCollectionEntriesTable.collectionId,
            input.filter.collection_id
          )
        );
    } else if (input.filter?.creator_id) {
      rows = await db
        .selectDistinct({
          id: videosTable.id,
          title: videosTable.title,
          fileName: videosTable.fileName,
        })
        .from(videosTable)
        .innerJoin(
          videoCreatorsTable,
          eq(videoCreatorsTable.videoId, videosTable.id)
        )
        .where(eq(videoCreatorsTable.creatorId, input.filter.creator_id));
    } else {
      rows = await db
        .select({
          id: videosTable.id,
          title: videosTable.title,
          fileName: videosTable.fileName,
        })
        .from(videosTable);
    }

    const requestByVideo = new Map(
      rows.map((row) => [row.id, this.requestForVideo(request, row)])
    );
    let videoIds = rows
      .filter((row) => (requestByVideo.get(row.id)?.variants.length ?? 0) > 0)
      .map((row) => row.id);
    if (videoIds.length === 0) return [];
    const existing = await db
      .select({
        videoId: artworkAssetsTable.videoId,
        variant: artworkAssetsTable.variant,
      })
      .from(artworkAssetsTable)
      .where(inArray(artworkAssetsTable.videoId, videoIds));
    const byVideo = new Map<number, Set<string>>();
    for (const asset of existing) {
      const variants = byVideo.get(asset.videoId) ?? new Set<string>();
      variants.add(asset.variant);
      byVideo.set(asset.videoId, variants);
    }
    if (input.filter?.missing_only) {
      videoIds = videoIds.filter((id) =>
        requestByVideo
          .get(id)
          ?.variants.some((variant) => !byVideo.get(id)?.has(variant))
      );
    }

    const jobs: Array<{ videoId: number; request: StoredArtworkRequest }> = [];
    for (const videoId of videoIds) {
      if (this.pendingVideoIds.has(videoId)) continue;
      const videoRequest = requestByVideo.get(videoId);
      if (!videoRequest) continue;
      const variants = request.force
        ? videoRequest.variants
        : videoRequest.variants.filter(
            (variant) => !byVideo.get(videoId)?.has(variant)
          );
      if (variants.length === 0) continue;
      jobs.push({ videoId, request: { ...videoRequest, variants } });
    }

    const batch = { total: jobs.length, completed: 0 };
    const queued: number[] = [];
    for (const job of jobs) {
      await db
        .insert(videoArtworkTable)
        .values({
          videoId: job.videoId,
          status: "generating",
          error: null,
          request: job.request,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: videoArtworkTable.videoId,
          set: {
            status: "generating",
            error: null,
            request: job.request,
            updatedAt: new Date(),
          },
        });
      this.enqueue({ videoId: job.videoId, request: job.request, batch });
      queued.push(job.videoId);
    }
    return queued;
  }

  async deleteByVideoId(videoId: number): Promise<void> {
    if (env.DEMO_MODE) {
      demoMediaAssetsService.deleteArtwork(videoId);
      return;
    }
    await videosService.findFilePathById(videoId);
    this.cancelledVideos.add(videoId);
    const assets = await db
      .select({ filePath: artworkAssetsTable.filePath })
      .from(artworkAssetsTable)
      .where(eq(artworkAssetsTable.videoId, videoId));
    await db.transaction(async (tx) => {
      await tx
        .delete(artworkAssetsTable)
        .where(eq(artworkAssetsTable.videoId, videoId));
      await tx
        .delete(videoArtworkTable)
        .where(eq(videoArtworkTable.videoId, videoId));
    });
    await Promise.all(assets.map((asset) => this.removeFile(asset.filePath)));
  }

  async resumePendingJobs(): Promise<void> {
    if (env.DEMO_MODE) return;
    const pending = await db
      .select({
        videoId: videoArtworkTable.videoId,
        request: videoArtworkTable.request,
      })
      .from(videoArtworkTable)
      .where(eq(videoArtworkTable.status, "generating"));
    for (const row of pending) {
      if (row.request && !this.pendingVideoIds.has(row.videoId)) {
        this.enqueue({
          videoId: row.videoId,
          request: row.request as StoredArtworkRequest,
        });
      }
    }
  }

  private enqueue(job: ArtworkJob): void {
    this.pendingVideoIds.add(job.videoId);
    this.queue.push(job);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.queue.length > 0) {
        const job = this.queue.shift();
        if (!job) continue;
        try {
          await this.processJob(job);
        } finally {
          this.pendingVideoIds.delete(job.videoId);
        }
      }
    } finally {
      this.processing = false;
    }
  }

  private async processJob(job: ArtworkJob): Promise<void> {
    let newPaths: string[] = [];
    try {
      if (this.cancelledVideos.has(job.videoId)) return;
      const video = await videosService.findById(job.videoId);
      const context = createVideoEventContext(video);
      eventsService.broadcastToAuthenticated({
        type: "artwork:generating",
        message: {
          ...context,
          variants: job.request.variants,
          ...(job.batch
            ? {
                progress: Math.round(
                  (job.batch.completed / Math.max(1, job.batch.total)) * 100
                ),
              }
            : {}),
        },
      });
      const generated = await generateArtworkFiles({
        video,
        request: job.request,
      });
      newPaths = generated.assets.map((asset) => asset.filePath);
      if (this.cancelledVideos.has(job.videoId)) {
        await Promise.all(newPaths.map((path) => this.removeFile(path)));
        return;
      }

      const oldAssets = await db
        .select({ filePath: artworkAssetsTable.filePath })
        .from(artworkAssetsTable)
        .where(
          and(
            eq(artworkAssetsTable.videoId, job.videoId),
            inArray(artworkAssetsTable.variant, job.request.variants)
          )
        );
      const currentSet = await db
        .select({ palette: videoArtworkTable.palette })
        .from(videoArtworkTable)
        .where(eq(videoArtworkTable.videoId, job.videoId))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      const now = new Date();
      await db.transaction(async (tx) => {
        await tx
          .delete(artworkAssetsTable)
          .where(
            and(
              eq(artworkAssetsTable.videoId, job.videoId),
              inArray(artworkAssetsTable.variant, job.request.variants)
            )
          );
        if (generated.assets.length > 0) {
          await tx.insert(artworkAssetsTable).values(
            generated.assets.map((asset) => ({
              videoId: asset.videoId,
              variant: asset.variant,
              contentHash: asset.contentHash,
              filePath: asset.filePath,
              fileSizeBytes: asset.fileSizeBytes,
              width: asset.width,
              height: asset.height,
              sourceTimestampSeconds: asset.sourceTimestampSeconds,
              crop: asset.crop,
              focalPoint: asset.focalPoint,
              safeArea: asset.safeArea,
              bottomLuma: asset.bottomLuma,
              thumbhash: asset.thumbhash,
              effects: asset.effects,
            }))
          );
        }
        await tx
          .update(videoArtworkTable)
          .set({
            status: "ready",
            palette: generated.palette ?? currentSet?.palette ?? null,
            error: null,
            request: null,
            generatedAt: now,
            updatedAt: now,
          })
          .where(eq(videoArtworkTable.videoId, job.videoId));
      });
      const retained = new Set(newPaths);
      await Promise.all(
        oldAssets
          .filter((asset) => !retained.has(asset.filePath))
          .map((asset) => this.removeFile(asset.filePath))
      );
      if (job.batch) job.batch.completed += 1;
      eventsService.broadcastToAuthenticated({
        type: "artwork:ready",
        message: {
          ...context,
          variants: job.request.variants,
          ...(job.batch
            ? {
                progress: Math.round(
                  (job.batch.completed / Math.max(1, job.batch.total)) * 100
                ),
              }
            : {}),
        },
      });
    } catch (error) {
      logger.error(
        { error, videoId: job.videoId },
        "Artwork generation failed"
      );
      await Promise.all(newPaths.map((path) => this.removeFile(path)));
      await db
        .update(videoArtworkTable)
        .set({
          status: "failed",
          error: "Artwork generation failed",
          request: null,
          updatedAt: new Date(),
        })
        .where(eq(videoArtworkTable.videoId, job.videoId));
      if (job.batch) job.batch.completed += 1;
      let context: ReturnType<typeof createVideoEventContext> = {
        videoId: job.videoId,
        video_id: job.videoId,
        videoTitle: `Video ${job.videoId}`,
        video_title: `Video ${job.videoId}`,
        fileName: "",
        file_name: "",
      };
      try {
        context = createVideoEventContext(
          await videosService.findById(job.videoId)
        );
      } catch {
        // The video may have been deleted while the background job was running.
      }
      eventsService.broadcastToAuthenticated({
        type: "artwork:error",
        message: {
          ...context,
          variants: job.request.variants,
          error: "Artwork generation failed",
          ...(job.batch
            ? {
                progress: Math.round(
                  (job.batch.completed / Math.max(1, job.batch.total)) * 100
                ),
              }
            : {}),
        },
      });
    }
  }

  private async removeFile(filePath: string): Promise<void> {
    try {
      await unlink(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        logger.warn({ error, filePath }, "Failed to remove artwork file");
      }
    }
  }
}

export const artworkService = new ArtworkService();
