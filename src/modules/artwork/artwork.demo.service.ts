import { API_PREFIX } from "@/config/constants";
import {
  demoRepository,
  getDemoArtworkRecord,
  resolveDemoAssetPath,
} from "@/database/demo";
import { NotFoundError } from "@/utils/errors";
import type {
  ArtworkAsset,
  ArtworkEffect,
  ArtworkPalette,
  ArtworkVariant,
  NormalizedPoint,
  NormalizedRect,
  VideoArtwork,
  VideoArtworkSummary,
} from "./artwork.types";

const VARIANT_CODES: Record<ArtworkVariant, number> = {
  card: 1,
  poster: 2,
  square: 3,
  hero: 4,
  title: 5,
};

const CODE_VARIANTS = new Map(
  Object.entries(VARIANT_CODES).map(([variant, code]) => [
    code,
    variant as ArtworkVariant,
  ])
);

interface DemoArtworkAssetRecord {
  variant: ArtworkVariant;
  content_hash: string;
  file_path: string;
  file_size_bytes: number;
  width: number;
  height: number;
  source_timestamp_seconds: number | null;
  crop: NormalizedRect | null;
  focal_point: NormalizedPoint | null;
  safe_area: NormalizedRect | null;
  bottom_luma: number | null;
  thumbhash: string | null;
  effects: ArtworkEffect[];
}

interface DemoArtworkRecord {
  title: string;
  palette: ArtworkPalette;
  assets: Partial<Record<ArtworkVariant, DemoArtworkAssetRecord>>;
}

export interface DemoArtworkAssetRow {
  id: number;
  videoId: number;
  variant: string;
  contentHash: string;
  filePath: string;
  fileSizeBytes: number;
  width: number;
  height: number;
  sourceTimestampSeconds: number | null;
  crop: unknown;
  focalPoint: unknown;
  safeArea: unknown;
  bottomLuma: number | null;
  thumbhash: string | null;
  effects: unknown;
  generatedAt: Date;
}

class DemoArtworkService {
  private assetId(videoId: number, variant: ArtworkVariant): number {
    return videoId * 10 + VARIANT_CODES[variant];
  }

  private assetUrl(videoId: number, asset: DemoArtworkAssetRecord): string {
    return `${API_PREFIX}/artwork/${this.assetId(videoId, asset.variant)}/image?h=${asset.content_hash}`;
  }

  private entryForVideo(
    video: any
  ): (DemoArtworkRecord & { generated_at: string }) | null {
    return getDemoArtworkRecord(video.id) as
      | (DemoArtworkRecord & { generated_at: string })
      | null;
  }

  private availableAssets(
    video: any,
    entry: DemoArtworkRecord
  ): DemoArtworkAssetRecord[] {
    return Object.values(entry.assets).filter(
      (asset): asset is DemoArtworkAssetRecord =>
        Boolean(asset) &&
        (asset?.variant !== "title" || video.title === entry.title)
    );
  }

  private mapAsset(
    videoId: number,
    asset: DemoArtworkAssetRecord,
    generatedAt: string
  ): ArtworkAsset {
    return {
      id: this.assetId(videoId, asset.variant),
      video_id: videoId,
      variant: asset.variant,
      url: this.assetUrl(videoId, asset),
      width: asset.width,
      height: asset.height,
      file_size_bytes: asset.file_size_bytes,
      source_timestamp_seconds: asset.source_timestamp_seconds,
      crop: asset.crop,
      focal_point: asset.focal_point,
      safe_area: asset.safe_area,
      bottom_luma: asset.bottom_luma,
      thumbhash: asset.thumbhash,
      effects: asset.effects,
      generated_at: generatedAt,
    };
  }

  getByVideoId(videoId: number): VideoArtwork {
    const video = demoRepository.getVideoById(videoId);
    const entry = this.entryForVideo(video);
    if (!entry) {
      return {
        video_id: videoId,
        status: "absent",
        palette: null,
        assets: [],
        error: null,
        generated_at: null,
      };
    }
    return {
      video_id: videoId,
      status: "ready",
      palette: entry.palette,
      assets: this.availableAssets(video, entry).map((asset) =>
        this.mapAsset(videoId, asset, entry.generated_at)
      ),
      error: null,
      generated_at: entry.generated_at,
    };
  }

  getSummariesByVideoIds(videoIds: number[]): Map<number, VideoArtworkSummary> {
    const summaries = new Map<number, VideoArtworkSummary>();
    for (const videoId of videoIds) {
      const video = demoRepository.getVideoById(videoId);
      const entry = this.entryForVideo(video);
      if (!entry) continue;
      const assets = this.availableAssets(video, entry);
      const urls: VideoArtworkSummary["urls"] = {};
      for (const asset of assets) {
        urls[asset.variant] = this.assetUrl(videoId, asset);
      }
      const card = assets.find((asset) => asset.variant === "card") ?? null;
      const hero = assets.find((asset) => asset.variant === "hero") ?? null;
      summaries.set(videoId, {
        urls,
        palette: entry.palette,
        focal_point: card?.focal_point ?? hero?.focal_point ?? null,
        safe_area: hero?.safe_area ?? card?.safe_area ?? null,
        bottom_luma: hero?.bottom_luma ?? card?.bottom_luma ?? null,
        thumbhash: card?.thumbhash ?? hero?.thumbhash ?? null,
      });
    }
    return summaries;
  }

  getAssetById(id: number): DemoArtworkAssetRow {
    const variant = CODE_VARIANTS.get(id % 10);
    const videoId = Math.floor(id / 10);
    if (!variant || videoId <= 0) {
      throw new NotFoundError(`Demo artwork asset not found with id: ${id}`);
    }
    const video = demoRepository.getVideoById(videoId);
    const entry = this.entryForVideo(video);
    const asset = entry?.assets[variant];
    if (!asset || (variant === "title" && video.title !== entry?.title)) {
      throw new NotFoundError(`Demo artwork asset not found with id: ${id}`);
    }
    const generatedAt = new Date(entry.generated_at);
    return {
      id,
      videoId,
      variant,
      contentHash: asset.content_hash,
      filePath: resolveDemoAssetPath(asset.file_path),
      fileSizeBytes: asset.file_size_bytes,
      width: asset.width,
      height: asset.height,
      sourceTimestampSeconds: asset.source_timestamp_seconds,
      crop: asset.crop,
      focalPoint: asset.focal_point,
      safeArea: asset.safe_area,
      bottomLuma: asset.bottom_luma,
      thumbhash: asset.thumbhash,
      effects: asset.effects,
      generatedAt,
    };
  }
}

export const demoArtworkService = new DemoArtworkService();
