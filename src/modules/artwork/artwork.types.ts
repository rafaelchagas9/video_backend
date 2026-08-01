export const ARTWORK_VARIANTS = [
  "card",
  "poster",
  "square",
  "hero",
  "title",
] as const;

export const RASTER_ARTWORK_VARIANTS = [
  "card",
  "poster",
  "square",
  "hero",
] as const;

export const ARTWORK_EFFECTS = ["scrim", "grain", "vignette", "title"] as const;

export type ArtworkVariant = (typeof ARTWORK_VARIANTS)[number];
export type RasterArtworkVariant = (typeof RASTER_ARTWORK_VARIANTS)[number];
export type ArtworkEffect = (typeof ARTWORK_EFFECTS)[number];
export type ArtworkStatus = "ready" | "generating" | "failed" | "absent";

export interface NormalizedPoint {
  x: number;
  y: number;
}

export interface NormalizedRect extends NormalizedPoint {
  width: number;
  height: number;
}

export interface ArtworkPalette {
  dominant: string;
  swatches: string[];
  mean_oklch: { l: number; c: number; h: number };
  is_neutral: boolean;
}

export interface ArtworkAsset {
  id: number;
  video_id: number;
  variant: ArtworkVariant;
  url: string;
  width: number;
  height: number;
  file_size_bytes: number;
  source_timestamp_seconds: number | null;
  crop: NormalizedRect | null;
  focal_point: NormalizedPoint | null;
  safe_area: NormalizedRect | null;
  bottom_luma: number | null;
  thumbhash: string | null;
  effects: ArtworkEffect[];
  generated_at: string;
}

export interface VideoArtwork {
  video_id: number;
  status: ArtworkStatus;
  palette: ArtworkPalette | null;
  assets: ArtworkAsset[];
  error: string | null;
  generated_at: string | null;
}

export interface VideoArtworkSummary {
  urls: Partial<Record<ArtworkVariant, string>>;
  palette: ArtworkPalette | null;
  focal_point: NormalizedPoint | null;
  safe_area: NormalizedRect | null;
  bottom_luma: number | null;
  thumbhash: string | null;
}

export interface GenerateArtworkInput {
  variants?: ArtworkVariant[];
  force?: boolean;
  timestamp_seconds?: number;
  effects?: ArtworkEffect[];
}

export interface BatchGenerateArtworkInput {
  video_ids?: number[];
  filter?: {
    collection_id?: number;
    creator_id?: number;
    missing_only?: boolean;
  };
  variants?: ArtworkVariant[];
  force?: boolean;
}

export interface StoredArtworkRequest {
  variants: ArtworkVariant[];
  force: boolean;
  timestamp_seconds?: number;
  effects?: ArtworkEffect[];
}

export interface GeneratedArtworkAsset {
  videoId: number;
  variant: ArtworkVariant;
  contentHash: string;
  filePath: string;
  fileSizeBytes: number;
  width: number;
  height: number;
  sourceTimestampSeconds: number | null;
  crop: NormalizedRect | null;
  focalPoint: NormalizedPoint | null;
  safeArea: NormalizedRect | null;
  bottomLuma: number | null;
  thumbhash: string | null;
  effects: ArtworkEffect[];
}

export interface GeneratedArtworkSet {
  assets: GeneratedArtworkAsset[];
  palette: ArtworkPalette | null;
}
