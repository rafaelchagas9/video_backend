import { createHash } from "crypto";
import { existsSync, mkdirSync, statSync, writeFileSync } from "fs";
import { basename, join, relative, resolve, sep } from "path";
import { and, eq, max } from "drizzle-orm";
import { env } from "@/config/env";
import {
  demoSchema,
  getDemoDatabase,
  removeDemoRuntimeAsset,
  resetDemoRuntimeAssets,
  resolveDemoAssetPath,
  withDemoTransaction,
} from "@/database/demo";
import { BadRequestError, NotFoundError } from "@/utils/errors";
import { computeFileHash } from "@/utils/file-utils";
import type {
  Creator,
  CreatorGalleryMedia,
} from "@/modules/creators/creators.types";
import type { Studio } from "@/modules/studios/studios.types";
import type {
  GenerateThumbnailInput,
  Thumbnail,
} from "@/modules/thumbnails/thumbnails.types";
import type {
  GenerateStoryboardInput,
  Storyboard,
} from "@/modules/storyboards/storyboards.types";
import type {
  ArtworkEffect,
  ArtworkPalette,
  ArtworkVariant,
  GenerateArtworkInput,
} from "@/modules/artwork/artwork.types";

const {
  demoArtworkAssetsTable,
  demoArtworkTable,
  demoCreatorGalleryTable,
  demoCreatorsTable,
  demoStoryboardsTable,
  demoStudiosTable,
  demoThumbnailsTable,
  demoVideosTable,
} = demoSchema;
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);
const dimensions: Record<ArtworkVariant, [number, number]> = {
  card: [800, 450],
  poster: [600, 900],
  square: [800, 800],
  hero: [1600, 900],
  title: [1200, 300],
};
const codes: Record<ArtworkVariant, number> = {
  card: 1,
  poster: 2,
  square: 3,
  hero: 4,
  title: 5,
};
const now = () => new Date().toISOString();
const digest = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");

export class DemoMediaAssetsService {
  resetRuntimeAssets(): void {
    resetDemoRuntimeAssets();
    this.runtimeRoot();
  }

  private runtimeRoot(): string {
    const root = resolve(process.cwd(), env.DEMO_ASSETS_DIR);
    mkdirSync(root, { recursive: true });
    const runtime = resolveDemoAssetPath(join(root, "runtime"), {
      mustExist: false,
    });
    mkdirSync(runtime, { recursive: true });
    return runtime;
  }

  private write(category: string, name: string, data: Buffer | string): string {
    const directory = resolveDemoAssetPath(join(this.runtimeRoot(), category), {
      mustExist: false,
    });
    mkdirSync(directory, { recursive: true });
    const path = resolveDemoAssetPath(join(directory, name), {
      mustExist: false,
    });
    writeFileSync(path, data);
    return path;
  }

  private placeholder(category: string, ownerId: number, seed: string): string {
    return this.write(
      category,
      `${ownerId}-${digest(seed).slice(0, 16)}.png`,
      PNG
    );
  }

  private simulatedUrl(url: string): Buffer {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new BadRequestError("Demo image URL must be a valid HTTP(S) URL");
    }
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password
    ) {
      throw new BadRequestError(
        "Demo image URL must use HTTP(S) without embedded credentials"
      );
    }
    return PNG;
  }

  private removeRuntime(path: string | null | undefined): void {
    removeDemoRuntimeAsset(path);
  }

  private creator(id: number) {
    const row = getDemoDatabase()
      .select()
      .from(demoCreatorsTable)
      .where(eq(demoCreatorsTable.id, id))
      .get();
    if (!row) throw new NotFoundError(`Creator not found with id: ${id}`);
    return row;
  }

  private studio(id: number) {
    const row = getDemoDatabase()
      .select()
      .from(demoStudiosTable)
      .where(eq(demoStudiosTable.id, id))
      .get();
    if (!row) throw new NotFoundError(`Studio not found with id: ${id}`);
    return row;
  }

  private video(id: number) {
    const row = getDemoDatabase()
      .select()
      .from(demoVideosTable)
      .where(eq(demoVideosTable.id, id))
      .get();
    if (!row) throw new NotFoundError(`Video not found with id: ${id}`);
    return row;
  }

  private nextGalleryId(creatorId: number): number {
    return (
      Number(
        getDemoDatabase()
          .select({ value: max(demoCreatorGalleryTable.id) })
          .from(demoCreatorGalleryTable)
          .where(eq(demoCreatorGalleryTable.creatorId, creatorId))
          .get()?.value ?? 0
      ) + 1
    );
  }

  private mapCreator(
    row: ReturnType<DemoMediaAssetsService["creator"]>
  ): Creator {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      profile_picture_path: row.profilePicturePath,
      main_picture_path: row.mainPicturePath,
      face_thumbnail_path: row.faceThumbnailPath,
      profile_picture_url: row.profilePicturePath
        ? `/api/creators/${row.id}/picture`
        : undefined,
      main_picture_url: row.mainPicturePath
        ? `/api/creators/${row.id}/picture?variant=main`
        : undefined,
      face_thumbnail_url: row.faceThumbnailPath
        ? `/api/creators/${row.id}/picture?type=face`
        : undefined,
      is_favorite: false,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
    };
  }

  uploadCreatorPicture(
    id: number,
    data: Buffer,
    variant: "portrait" | "main"
  ): Creator {
    this.creator(id);
    const mediaId = this.nextGalleryId(id);
    const path = this.write(
      "creators",
      `${id}-${mediaId}-${variant}-${digest(data).slice(0, 16)}.png`,
      data
    );
    const timestamp = now();
    withDemoTransaction(() => {
      getDemoDatabase()
        .update(demoCreatorGalleryTable)
        .set(
          variant === "main"
            ? { isMainPicture: false }
            : { isProfilePicture: false }
        )
        .where(eq(demoCreatorGalleryTable.creatorId, id))
        .run();
      getDemoDatabase()
        .insert(demoCreatorGalleryTable)
        .values({
          id: mediaId,
          creatorId: id,
          label: variant === "main" ? "Main picture" : "Profile picture",
          description: null,
          filePath: path,
          isProfilePicture: variant === "portrait",
          isMainPicture: variant === "main",
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .run();
      getDemoDatabase()
        .update(demoCreatorsTable)
        .set(
          variant === "main"
            ? { mainPicturePath: path, updatedAt: timestamp }
            : { profilePicturePath: path, updatedAt: timestamp }
        )
        .where(eq(demoCreatorsTable.id, id))
        .run();
    });
    return this.mapCreator(this.creator(id));
  }

  setCreatorPictureFromUrl(
    id: number,
    url: string,
    variant: "portrait" | "main"
  ): Creator {
    return this.uploadCreatorPicture(id, this.simulatedUrl(url), variant);
  }

  deleteCreatorPicture(id: number, variant: "portrait" | "main"): Creator {
    this.creator(id);
    const timestamp = now();
    getDemoDatabase()
      .update(demoCreatorGalleryTable)
      .set(
        variant === "main"
          ? { isMainPicture: false, updatedAt: timestamp }
          : { isProfilePicture: false, updatedAt: timestamp }
      )
      .where(eq(demoCreatorGalleryTable.creatorId, id))
      .run();
    getDemoDatabase()
      .update(demoCreatorsTable)
      .set(
        variant === "main"
          ? { mainPicturePath: null, updatedAt: timestamp }
          : {
              profilePicturePath: null,
              faceThumbnailPath: null,
              updatedAt: timestamp,
            }
      )
      .where(eq(demoCreatorsTable.id, id))
      .run();
    return this.mapCreator(this.creator(id));
  }

  addGallery(
    id: number,
    data: Buffer,
    label?: string,
    description?: string
  ): CreatorGalleryMedia {
    this.creator(id);
    const timestamp = now();
    const mediaId = this.nextGalleryId(id);
    const path = this.write(
      "creator-gallery",
      `${id}-${mediaId}-${digest(data).slice(0, 16)}.png`,
      data
    );
    getDemoDatabase()
      .insert(demoCreatorGalleryTable)
      .values({
        id: mediaId,
        creatorId: id,
        label: label?.trim() || null,
        description: description?.trim() || null,
        filePath: path,
        isProfilePicture: false,
        isMainPicture: false,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .run();
    return this.gallery(id, mediaId);
  }

  addGalleryFromUrl(
    id: number,
    url: string,
    label?: string,
    description?: string
  ): CreatorGalleryMedia {
    return this.addGallery(id, this.simulatedUrl(url), label, description);
  }

  gallery(creatorId: number, mediaId: number): CreatorGalleryMedia {
    const row = getDemoDatabase()
      .select()
      .from(demoCreatorGalleryTable)
      .where(
        and(
          eq(demoCreatorGalleryTable.creatorId, creatorId),
          eq(demoCreatorGalleryTable.id, mediaId)
        )
      )
      .get();
    if (!row)
      throw new NotFoundError(
        `Creator gallery media not found with id: ${mediaId}`
      );
    return {
      id: row.id,
      creator_id: row.creatorId,
      label: row.label,
      description: row.description,
      file_path: row.filePath,
      is_profile_picture: row.isProfilePicture,
      is_main_picture: row.isMainPicture,
      url: `/api/creators/${row.creatorId}/gallery/${row.id}/image`,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
    };
  }

  deleteGallery(creatorId: number, mediaId: number): void {
    const media = this.gallery(creatorId, mediaId);
    const timestamp = now();
    withDemoTransaction(() => {
      getDemoDatabase()
        .delete(demoCreatorGalleryTable)
        .where(
          and(
            eq(demoCreatorGalleryTable.creatorId, creatorId),
            eq(demoCreatorGalleryTable.id, mediaId)
          )
        )
        .run();
      if (media.is_profile_picture || media.is_main_picture) {
        getDemoDatabase()
          .update(demoCreatorsTable)
          .set({
            ...(media.is_profile_picture
              ? { profilePicturePath: null, faceThumbnailPath: null }
              : {}),
            ...(media.is_main_picture ? { mainPicturePath: null } : {}),
            updatedAt: timestamp,
          })
          .where(eq(demoCreatorsTable.id, creatorId))
          .run();
      }
    });
    this.removeRuntime(media.file_path);
  }

  uploadStudioPicture(id: number, data: Buffer): Studio {
    const studio = this.studio(id);
    const path = this.write(
      "studios",
      `${id}-profile-${digest(data).slice(0, 16)}.png`,
      data
    );
    getDemoDatabase()
      .update(demoStudiosTable)
      .set({ profilePicturePath: path, updatedAt: now() })
      .where(eq(demoStudiosTable.id, id))
      .run();
    if (studio.profilePicturePath !== path)
      this.removeRuntime(studio.profilePicturePath);
    return this.mapStudio(this.studio(id));
  }

  setStudioPictureFromUrl(id: number, url: string): Studio {
    return this.uploadStudioPicture(id, this.simulatedUrl(url));
  }
  deleteStudioPicture(id: number): Studio {
    const studio = this.studio(id);
    getDemoDatabase()
      .update(demoStudiosTable)
      .set({ profilePicturePath: null, updatedAt: now() })
      .where(eq(demoStudiosTable.id, id))
      .run();
    this.removeRuntime(studio.profilePicturePath);
    return this.mapStudio(this.studio(id));
  }
  private mapStudio(row: ReturnType<DemoMediaAssetsService["studio"]>): Studio {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      profile_picture_path: row.profilePicturePath,
      profile_picture_url: row.profilePicturePath
        ? `/api/studios/${row.id}/picture`
        : undefined,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
    };
  }

  generateThumbnail(
    videoId: number,
    input?: GenerateThumbnailInput
  ): Thumbnail {
    const video = this.video(videoId);
    const current = getDemoDatabase()
      .select()
      .from(demoThumbnailsTable)
      .where(eq(demoThumbnailsTable.videoId, videoId))
      .get();
    const path = this.placeholder(
      "thumbnails",
      videoId,
      `thumbnail:${videoId}:${JSON.stringify(input ?? {})}`
    );
    const seconds =
      input?.timestamp ??
      (input?.positionPercent !== undefined && video.durationSeconds
        ? (video.durationSeconds * input.positionPercent) / 100
        : 0);
    const generatedAt = now();
    const values = {
      videoId,
      filePath: path,
      fileSizeBytes: statSync(path).size,
      timestampSeconds: seconds,
      width: 320,
      height: 180,
      generatedAt,
    };
    getDemoDatabase()
      .insert(demoThumbnailsTable)
      .values(values)
      .onConflictDoUpdate({ target: demoThumbnailsTable.videoId, set: values })
      .run();
    if (current?.filePath !== path) this.removeRuntime(current?.filePath);
    return this.thumbnail(videoId);
  }

  thumbnail(videoId: number): Thumbnail {
    const row = getDemoDatabase()
      .select()
      .from(demoThumbnailsTable)
      .where(eq(demoThumbnailsTable.videoId, videoId))
      .get();
    if (!row)
      throw new NotFoundError(`Thumbnail not found with id: ${videoId}`);
    return {
      id: row.videoId,
      video_id: row.videoId,
      file_path: row.filePath,
      file_size_bytes: row.fileSizeBytes,
      timestamp_seconds: row.timestampSeconds,
      width: row.width,
      height: row.height,
      generated_at: row.generatedAt,
    };
  }

  deleteThumbnail(id: number): void {
    const thumbnail = this.thumbnail(id);
    getDemoDatabase()
      .delete(demoThumbnailsTable)
      .where(eq(demoThumbnailsTable.videoId, id))
      .run();
    this.removeRuntime(thumbnail.file_path);
  }

  generateStoryboard(
    videoId: number,
    input?: GenerateStoryboardInput
  ): Storyboard {
    const video = this.video(videoId);
    const current = getDemoDatabase()
      .select()
      .from(demoStoryboardsTable)
      .where(eq(demoStoryboardsTable.videoId, videoId))
      .get();
    const intervalSeconds = input?.intervalSeconds ?? 10;
    const tileCount = Math.max(
      1,
      Math.ceil((video.durationSeconds ?? intervalSeconds) / intervalSeconds)
    );
    const tileWidth = input?.tileWidth ?? 160;
    const tileHeight = input?.tileHeight ?? 90;
    const spritePath = this.placeholder(
      "storyboards",
      videoId,
      `storyboard:${videoId}:${JSON.stringify(input ?? {})}`
    );
    const vttPath = this.write(
      "storyboards",
      `${videoId}-${digest(`vtt:${videoId}:${intervalSeconds}`).slice(0, 16)}.vtt`,
      `WEBVTT\n\n00:00:00.000 --> 99:59:59.999\n/api/videos/${videoId}/storyboard.webp#xywh=0,0,${tileWidth},${tileHeight}\n`
    );
    const generatedAt = now();
    const values = {
      videoId,
      spritePath,
      vttPath,
      tileWidth,
      tileHeight,
      tileCount,
      intervalSeconds,
      spriteSizeBytes: statSync(spritePath).size,
      generatedAt,
    };
    getDemoDatabase()
      .insert(demoStoryboardsTable)
      .values(values)
      .onConflictDoUpdate({ target: demoStoryboardsTable.videoId, set: values })
      .run();
    if (current?.spritePath !== spritePath)
      this.removeRuntime(current?.spritePath);
    if (current?.vttPath !== vttPath) this.removeRuntime(current?.vttPath);
    return this.storyboard(videoId);
  }

  storyboard(videoId: number): Storyboard {
    const row = getDemoDatabase()
      .select()
      .from(demoStoryboardsTable)
      .where(eq(demoStoryboardsTable.videoId, videoId))
      .get();
    if (!row)
      throw new NotFoundError(`Storyboard not found for video: ${videoId}`);
    return {
      id: row.videoId,
      video_id: row.videoId,
      sprite_path: row.spritePath,
      vtt_path: row.vttPath,
      tile_width: row.tileWidth,
      tile_height: row.tileHeight,
      tile_count: row.tileCount,
      interval_seconds: row.intervalSeconds,
      sprite_size_bytes: row.spriteSizeBytes,
      generated_at: row.generatedAt,
      sprite_url: `/api/videos/${videoId}/storyboard.webp`,
      vtt_url: `/api/videos/${videoId}/thumbnails.vtt`,
    };
  }

  deleteStoryboard(videoId: number): void {
    const story = this.storyboard(videoId);
    getDemoDatabase()
      .delete(demoStoryboardsTable)
      .where(eq(demoStoryboardsTable.videoId, videoId))
      .run();
    this.removeRuntime(story.sprite_path);
    this.removeRuntime(story.vtt_path);
  }

  generateArtwork(videoId: number, input: GenerateArtworkInput = {}): void {
    const video = this.video(videoId);
    const variants = input.variants ?? [
      "card",
      "poster",
      "square",
      "hero",
      "title",
    ];
    const generatedAt = now();
    const palette: ArtworkPalette = {
      dominant: "#64748b",
      swatches: ["#64748b", "#0f172a"],
      mean_oklch: { l: 0.55, c: 0.05, h: 250 },
      is_neutral: true,
    };
    const title = video.title ?? video.fileName.replace(/\.[^.]+$/, "");
    getDemoDatabase()
      .insert(demoArtworkTable)
      .values({
        videoId,
        title,
        status: "ready",
        paletteJson: JSON.stringify(palette),
        generatedAt,
      })
      .onConflictDoUpdate({
        target: demoArtworkTable.videoId,
        set: {
          title,
          status: "ready",
          paletteJson: JSON.stringify(palette),
          generatedAt,
        },
      })
      .run();
    for (const variant of variants) {
      const current = getDemoDatabase()
        .select()
        .from(demoArtworkAssetsTable)
        .where(
          and(
            eq(demoArtworkAssetsTable.videoId, videoId),
            eq(demoArtworkAssetsTable.variant, variant)
          )
        )
        .get();
      if (current && !input.force) continue;
      const path = this.placeholder(
        "artwork",
        videoId,
        `artwork:${videoId}:${variant}:${JSON.stringify(input.effects ?? [])}`
      );
      const [width, height] = dimensions[variant];
      const effects = (input.effects ??
        (variant === "title" ? ["title"] : [])) as ArtworkEffect[];
      const values = {
        id: videoId * 10 + codes[variant],
        videoId,
        variant,
        contentHash: digest(`${videoId}:${variant}:${generatedAt}`).slice(
          0,
          16
        ),
        filePath: path,
        fileSizeBytes: statSync(path).size,
        width,
        height,
        sourceTimestampSeconds: input.timestamp_seconds ?? null,
        cropJson: null,
        focalPointJson: null,
        safeAreaJson: null,
        bottomLuma: null,
        thumbhash: null,
        effectsJson: JSON.stringify(effects),
        generatedAt,
      };
      getDemoDatabase()
        .insert(demoArtworkAssetsTable)
        .values(values)
        .onConflictDoUpdate({
          target: [
            demoArtworkAssetsTable.videoId,
            demoArtworkAssetsTable.variant,
          ],
          set: values,
        })
        .run();
      if (current?.filePath !== path) this.removeRuntime(current?.filePath);
    }
  }

  deleteArtwork(videoId: number): void {
    this.video(videoId);
    const assets = getDemoDatabase()
      .select()
      .from(demoArtworkAssetsTable)
      .where(eq(demoArtworkAssetsTable.videoId, videoId))
      .all();
    withDemoTransaction(() => {
      getDemoDatabase()
        .delete(demoArtworkAssetsTable)
        .where(eq(demoArtworkAssetsTable.videoId, videoId))
        .run();
      getDemoDatabase()
        .delete(demoArtworkTable)
        .where(eq(demoArtworkTable.videoId, videoId))
        .run();
    });
    for (const asset of assets) this.removeRuntime(asset.filePath);
  }

  async refreshVideo(videoId: number): Promise<void> {
    const video = this.video(videoId);
    const path = resolveDemoAssetPath(video.filePath, { mustExist: false });
    const timestamp = now();
    const available = existsSync(path);
    getDemoDatabase()
      .update(demoVideosTable)
      .set({
        isAvailable: available,
        lastVerifiedAt: timestamp,
        fileSizeBytes: available ? statSync(path).size : video.fileSizeBytes,
        fileHash: available ? await computeFileHash(path) : video.fileHash,
        updatedAt: timestamp,
      })
      .where(eq(demoVideosTable.id, videoId))
      .run();
    this.generateThumbnail(videoId);
  }

  async replaceVideoFile(videoId: number, newFilePath: string): Promise<void> {
    this.video(videoId);
    const path = resolveDemoAssetPath(newFilePath, { mustExist: true });
    const fromRuntime = relative(this.runtimeRoot(), path);
    if (
      fromRuntime === "" ||
      fromRuntime === ".." ||
      fromRuntime.startsWith(`..${sep}`)
    )
      throw new BadRequestError(
        "Demo replacement files must be inside DEMO_ASSETS_DIR/runtime"
      );
    const timestamp = now();
    getDemoDatabase()
      .update(demoVideosTable)
      .set({
        filePath: path,
        fileName: basename(path),
        fileSizeBytes: statSync(path).size,
        fileHash: await computeFileHash(path),
        isAvailable: true,
        lastVerifiedAt: timestamp,
        updatedAt: timestamp,
      })
      .where(eq(demoVideosTable.id, videoId))
      .run();
  }
}

export const demoMediaAssetsService = new DemoMediaAssetsService();
