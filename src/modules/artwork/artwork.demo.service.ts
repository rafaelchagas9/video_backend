import { readFileSync, realpathSync, statSync } from "fs";
import { join, resolve, sep } from "path";
import { API_PREFIX } from "@/config/constants";
import { demoMockService, isDemoAssetPath } from "@/utils/demo-mock";
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
  ]),
);

interface DemoManifestAsset {
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

interface DemoManifestEntry {
  title: string;
  palette: ArtworkPalette;
  assets: Partial<Record<ArtworkVariant, DemoManifestAsset>>;
}

interface DemoArtworkManifest {
  version: number;
  generated_at: string;
  entries: Record<string, DemoManifestEntry>;
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
  private manifest: DemoArtworkManifest | null = null;
  private modifiedAtMs = 0;

  private loadManifest(): DemoArtworkManifest {
    const manifestPath = join(
      process.cwd(),
      "demo_mode",
      "artwork",
      "manifest.json",
    );
    const modifiedAtMs = statSync(manifestPath).mtimeMs;
    if (this.manifest && modifiedAtMs <= this.modifiedAtMs) {
      return this.manifest;
    }

    const manifest = JSON.parse(
      readFileSync(manifestPath, "utf8"),
    ) as DemoArtworkManifest;
    if (manifest.version !== 1) {
      throw new Error(`Unsupported demo artwork manifest: ${manifest.version}`);
    }
    for (const entry of Object.values(manifest.entries)) {
      for (const asset of Object.values(entry.assets)) {
        if (!asset || !isDemoAssetPath(asset.file_path)) {
          throw new Error("Demo artwork manifest contains an unsafe asset path");
        }
        const demoRoot = realpathSync(resolve(process.cwd(), "demo_mode"));
        const filePath = realpathSync(resolve(process.cwd(), asset.file_path));
        if (!filePath.startsWith(`${demoRoot}${sep}`)) {
          throw new Error("Demo artwork asset escapes demo_mode");
        }
      }
    }

    this.manifest = manifest;
    this.modifiedAtMs = modifiedAtMs;
    return manifest;
  }

  private assetId(videoId: number, variant: ArtworkVariant): number {
    return videoId * 10 + VARIANT_CODES[variant];
  }

  private assetUrl(videoId: number, asset: DemoManifestAsset): string {
    return `${API_PREFIX}/artwork/${this.assetId(videoId, asset.variant)}/image?h=${asset.content_hash}`;
  }

  private entryForVideo(video: any): DemoManifestEntry | null {
    const thumbnailPath = video.thumbnail?.file_path;
    if (!thumbnailPath) return null;
    return this.loadManifest().entries[thumbnailPath] ?? null;
  }

  private availableAssets(
    video: any,
    entry: DemoManifestEntry,
  ): DemoManifestAsset[] {
    return Object.values(entry.assets).filter(
      (asset): asset is DemoManifestAsset =>
        Boolean(asset) &&
        (asset?.variant !== "title" || video.title === entry.title),
    );
  }

  private mapAsset(
    videoId: number,
    asset: DemoManifestAsset,
    generatedAt: string,
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
    const video = demoMockService.getVideoById(videoId);
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
    const manifest = this.loadManifest();
    return {
      video_id: videoId,
      status: "ready",
      palette: entry.palette,
      assets: this.availableAssets(video, entry).map((asset) =>
        this.mapAsset(videoId, asset, manifest.generated_at),
      ),
      error: null,
      generated_at: manifest.generated_at,
    };
  }

  getSummariesByVideoIds(
    videoIds: number[],
  ): Map<number, VideoArtworkSummary> {
    const summaries = new Map<number, VideoArtworkSummary>();
    for (const videoId of videoIds) {
      const video = demoMockService.getVideoById(videoId);
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
    const video = demoMockService.getVideoById(videoId);
    const entry = this.entryForVideo(video);
    const asset = entry?.assets[variant];
    if (!asset || (variant === "title" && video.title !== entry?.title)) {
      throw new NotFoundError(`Demo artwork asset not found with id: ${id}`);
    }
    const generatedAt = new Date(this.loadManifest().generated_at);
    return {
      id,
      videoId,
      variant,
      contentHash: asset.content_hash,
      filePath: resolve(process.cwd(), asset.file_path),
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
