import { eq, and, sql } from "drizzle-orm";
import { db } from "@/config/drizzle";
import {
  creatorGalleryMediaTable,
  creatorSocialLinksTable,
  creatorsTable,
  creatorFaceEmbeddingsTable,
} from "@/database/schema";
import { NotFoundError } from "@/utils/errors";
import { env } from "@/config/env";
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import {
  getFaceRecognitionClient,
  getFaceRecognitionService,
} from "@/modules/face-recognition";
import {
  cropFaceThumbnail,
  processProfilePicture,
} from "@/utils/image-processing";
import { logger } from "@/utils/logger";
import { imageDownloadRateLimiter } from "@/utils/async-rate-limiter";
import type {
  SocialLink,
  CreateSocialLinkInput,
  UpdateSocialLinkInput,
  BulkSocialLinkItem,
  BulkOperationResult,
  CreatorGalleryMedia,
} from "./creators.types";
import type { Creator } from "./creators.types";
import { creatorsDemoService } from "./creators.demo.service";
import { demoMediaAssetsService } from "@/modules/media/demo-media-assets.service";

type CreatorPictureVariant = "portrait" | "main";

export class CreatorsSocialService {
  // Social Links Methods
  async addSocialLink(
    creatorId: number,
    input: CreateSocialLinkInput
  ): Promise<SocialLink> {
    if (env.DEMO_MODE)
      return creatorsDemoService.addSocialLink(creatorId, input);
    // Verify creator exists
    const creator = await db
      .select({ id: creatorsTable.id })
      .from(creatorsTable)
      .where(eq(creatorsTable.id, creatorId))
      .limit(1);

    if (!creator || creator.length === 0) {
      throw new NotFoundError(`Creator not found with id: ${creatorId}`);
    }

    const result = await db
      .insert(creatorSocialLinksTable)
      .values({
        creatorId,
        platformName: input.platform_name,
        url: input.url,
      })
      .returning({ id: creatorSocialLinksTable.id });

    if (!result || result.length === 0) {
      throw new Error("Failed to add social link");
    }

    return this.findSocialLinkById(result[0].id);
  }

  async updateSocialLink(
    id: number,
    input: UpdateSocialLinkInput,
    creatorId?: number
  ): Promise<SocialLink> {
    if (env.DEMO_MODE) {
      if (creatorId === undefined)
        throw new NotFoundError(`Social link not found with id: ${id}`);
      return creatorsDemoService.updateSocialLink(creatorId, id, input);
    }
    await this.findSocialLinkById(id); // Ensure exists

    const updates: any = {};

    if (input.platform_name !== undefined) {
      updates.platformName = input.platform_name;
    }

    if (input.url !== undefined) {
      updates.url = input.url;
    }

    if (Object.keys(updates).length === 0) {
      return this.findSocialLinkById(id);
    }

    await db
      .update(creatorSocialLinksTable)
      .set(updates)
      .where(eq(creatorSocialLinksTable.id, id));

    return this.findSocialLinkById(id);
  }

  async deleteSocialLink(id: number, creatorId?: number): Promise<void> {
    if (env.DEMO_MODE) {
      if (creatorId === undefined)
        throw new NotFoundError(`Social link not found with id: ${id}`);
      creatorsDemoService.deleteSocialLink(creatorId, id);
      return;
    }
    await this.findSocialLinkById(id); // Ensure exists
    await db
      .delete(creatorSocialLinksTable)
      .where(eq(creatorSocialLinksTable.id, id));
  }

  async getSocialLinks(creatorId: number): Promise<SocialLink[]> {
    if (env.DEMO_MODE) {
      return creatorsDemoService.getSocialLinks(creatorId);
    }

    // Verify creator exists
    const creator = await db
      .select({ id: creatorsTable.id })
      .from(creatorsTable)
      .where(eq(creatorsTable.id, creatorId))
      .limit(1);

    if (!creator || creator.length === 0) {
      throw new NotFoundError(`Creator not found with id: ${creatorId}`);
    }

    const links = await db
      .select()
      .from(creatorSocialLinksTable)
      .where(eq(creatorSocialLinksTable.creatorId, creatorId))
      .orderBy(creatorSocialLinksTable.platformName);

    return links.map(this.mapToSnakeCase);
  }

  async bulkUpsertSocialLinks(
    creatorId: number,
    items: BulkSocialLinkItem[]
  ): Promise<BulkOperationResult<SocialLink>> {
    if (env.DEMO_MODE) {
      const created: SocialLink[] = [];
      const updated: SocialLink[] = [];
      const errors: Array<{ index: number; error: string }> = [];
      const existing = creatorsDemoService.getSocialLinks(creatorId);
      for (let index = 0; index < items.length; index++) {
        const item = items[index];
        try {
          const match = existing.find(
            (link) => link.platform_name === item.platform_name
          );
          if (match)
            updated.push(
              creatorsDemoService.updateSocialLink(creatorId, match.id, item)
            );
          else created.push(creatorsDemoService.addSocialLink(creatorId, item));
        } catch (error) {
          errors.push({
            index,
            error: error instanceof Error ? error.message : "Unknown error",
          });
        }
      }
      return { created, updated, errors };
    }
    // Verify creator exists
    const creator = await db
      .select({ id: creatorsTable.id })
      .from(creatorsTable)
      .where(eq(creatorsTable.id, creatorId))
      .limit(1);

    if (!creator || creator.length === 0) {
      throw new NotFoundError(`Creator not found with id: ${creatorId}`);
    }

    const created: SocialLink[] = [];
    const updated: SocialLink[] = [];
    const errors: Array<{ index: number; error: string }> = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      try {
        // Check if exists by platform_name + url
        const exactMatch = await db
          .select({ id: creatorSocialLinksTable.id })
          .from(creatorSocialLinksTable)
          .where(
            and(
              eq(creatorSocialLinksTable.creatorId, creatorId),
              eq(creatorSocialLinksTable.platformName, item.platform_name),
              eq(creatorSocialLinksTable.url, item.url)
            )
          )
          .limit(1);

        if (exactMatch && exactMatch.length > 0) {
          // Already exists with same data, add to updated
          updated.push(await this.findSocialLinkById(exactMatch[0].id));
        } else {
          // Check if exists by platform_name only (update url)
          const platformMatch = await db
            .select({ id: creatorSocialLinksTable.id })
            .from(creatorSocialLinksTable)
            .where(
              and(
                eq(creatorSocialLinksTable.creatorId, creatorId),
                eq(creatorSocialLinksTable.platformName, item.platform_name)
              )
            )
            .limit(1);

          if (platformMatch && platformMatch.length > 0) {
            // Update URL
            await db
              .update(creatorSocialLinksTable)
              .set({ url: item.url })
              .where(eq(creatorSocialLinksTable.id, platformMatch[0].id));

            updated.push(await this.findSocialLinkById(platformMatch[0].id));
          } else {
            // Create new
            const result = await db
              .insert(creatorSocialLinksTable)
              .values({
                creatorId,
                platformName: item.platform_name,
                url: item.url,
              })
              .returning({ id: creatorSocialLinksTable.id });

            if (!result || result.length === 0) {
              throw new Error("Failed to insert social link");
            }

            created.push(await this.findSocialLinkById(result[0].id));
          }
        }
      } catch (error: any) {
        errors.push({ index: i, error: error.message || "Unknown error" });
      }
    }

    return { created, updated, errors };
  }

  // Creator image methods
  async uploadProfilePicture(
    id: number,
    fileBuffer: Buffer,
    _filename: string,
    variant: CreatorPictureVariant = "portrait"
  ): Promise<Creator> {
    if (env.DEMO_MODE)
      return demoMediaAssetsService.uploadCreatorPicture(
        id,
        fileBuffer,
        variant
      );
    const creator = await this.findCreatorById(id);
    const filePath = await this.storeProcessedImage({
      input: fileBuffer,
      namePrefix: variant === "main" ? `creator_main_${id}` : `creator_${id}`,
      maxSize:
        variant === "main"
          ? env.PROFILE_PICTURE_MAX_SIZE * 2
          : env.PROFILE_PICTURE_MAX_SIZE,
    });

    if (variant === "main") {
      await this.clearImageRole(id, "main");

      await this.createGalleryImage(id, filePath, {
        label: "Main picture",
        isMainPicture: true,
      });

      await this.touchCreator(id);

      return this.findCreatorById(id);
    }

    this.deleteFileIfExists(creator.face_thumbnail_path);
    await this.clearImageRole(id, "portrait");

    const faceThumbnailPath = await this.generateFaceThumbnail(filePath, id);

    if (faceThumbnailPath) {
      await this.generateProfilePictureEmbedding(filePath, id);
    }

    await this.createGalleryImage(id, filePath, {
      label: "Profile picture",
      isProfilePicture: true,
    });

    await db
      .update(creatorsTable)
      .set({
        faceThumbnailPath,
        updatedAt: new Date(),
      })
      .where(eq(creatorsTable.id, id));

    return this.findCreatorById(id);
  }

  async deleteProfilePicture(
    id: number,
    variant: CreatorPictureVariant = "portrait"
  ): Promise<Creator> {
    if (env.DEMO_MODE)
      return demoMediaAssetsService.deleteCreatorPicture(id, variant);
    const creator = await this.findCreatorById(id);

    if (variant === "main") {
      await this.clearImageRole(id, "main");
      await this.touchCreator(id);

      return this.findCreatorById(id);
    }

    this.deleteFileIfExists(creator.face_thumbnail_path);
    await this.clearImageRole(id, "portrait");

    await db
      .update(creatorsTable)
      .set({
        faceThumbnailPath: null,
        updatedAt: new Date(),
      })
      .where(eq(creatorsTable.id, id));

    return this.findCreatorById(id);
  }

  async setPictureFromUrl(
    creatorId: number,
    url: string,
    variant: CreatorPictureVariant = "portrait"
  ): Promise<Creator> {
    if (env.DEMO_MODE)
      return demoMediaAssetsService.setCreatorPictureFromUrl(
        creatorId,
        url,
        variant
      );
    const buffer = await this.downloadImage(url);
    return this.uploadProfilePicture(
      creatorId,
      buffer,
      "downloaded-image",
      variant
    );
  }

  async listGalleryMedia(creatorId: number): Promise<CreatorGalleryMedia[]> {
    if (env.DEMO_MODE) {
      return creatorsDemoService.listGallery(creatorId);
    }

    await this.findCreatorById(creatorId);

    const media = await db
      .select()
      .from(creatorGalleryMediaTable)
      .where(eq(creatorGalleryMediaTable.creatorId, creatorId))
      .orderBy(creatorGalleryMediaTable.createdAt, creatorGalleryMediaTable.id);

    return media
      .slice()
      .reverse()
      .map((item) => this.mapGalleryMediaToSnakeCase(item));
  }

  async addGalleryMedia(
    creatorId: number,
    fileBuffer: Buffer,
    label?: string,
    description?: string
  ): Promise<CreatorGalleryMedia> {
    if (env.DEMO_MODE)
      return demoMediaAssetsService.addGallery(
        creatorId,
        fileBuffer,
        label,
        description
      );
    await this.findCreatorById(creatorId);

    const filePath = await this.storeProcessedImage({
      input: fileBuffer,
      namePrefix: `creator_gallery_${creatorId}`,
      maxSize: env.PROFILE_PICTURE_MAX_SIZE * 2,
    });

    const result = await db
      .insert(creatorGalleryMediaTable)
      .values({
        creatorId,
        label: this.normalizeOptionalText(label),
        description: this.normalizeOptionalText(description),
        filePath,
      })
      .returning();

    if (!result[0]) {
      throw new Error("Failed to create creator gallery media");
    }

    return this.mapGalleryMediaToSnakeCase(result[0]);
  }

  async addGalleryMediaFromUrl(
    creatorId: number,
    url: string,
    label?: string,
    description?: string
  ): Promise<CreatorGalleryMedia> {
    if (env.DEMO_MODE)
      return demoMediaAssetsService.addGalleryFromUrl(
        creatorId,
        url,
        label,
        description
      );
    const buffer = await this.downloadImage(url);
    return this.addGalleryMedia(creatorId, buffer, label, description);
  }

  async deleteGalleryMedia(creatorId: number, mediaId: number): Promise<void> {
    if (env.DEMO_MODE) {
      demoMediaAssetsService.deleteGallery(creatorId, mediaId);
      return;
    }
    const media = await this.findGalleryMediaById(creatorId, mediaId);

    this.deleteFileIfExists(media.file_path);

    await db
      .delete(creatorGalleryMediaTable)
      .where(eq(creatorGalleryMediaTable.id, mediaId));
  }

  /**
   * Fetch a single gallery media row (scoped to the creator). Throws
   * NotFoundError if the media does not belong to the creator.
   */
  async getGalleryMediaById(
    creatorId: number,
    mediaId: number
  ): Promise<CreatorGalleryMedia> {
    if (env.DEMO_MODE) {
      return demoMediaAssetsService.gallery(creatorId, mediaId);
    }
    return this.findGalleryMediaById(creatorId, mediaId);
  }

  async updateGalleryMediaRoles(
    creatorId: number,
    mediaId: number,
    roles: { is_profile_picture?: boolean; is_main_picture?: boolean }
  ): Promise<CreatorGalleryMedia> {
    if (env.DEMO_MODE)
      return creatorsDemoService.updateGalleryRoles(creatorId, mediaId, roles);
    await this.findGalleryMediaById(creatorId, mediaId);

    if (roles.is_profile_picture === true) {
      await this.clearImageRole(creatorId, "portrait");
    }

    if (roles.is_main_picture === true) {
      await this.clearImageRole(creatorId, "main");
    }

    await db
      .update(creatorGalleryMediaTable)
      .set({
        ...(roles.is_profile_picture !== undefined && {
          isProfilePicture: roles.is_profile_picture,
        }),
        ...(roles.is_main_picture !== undefined && {
          isMainPicture: roles.is_main_picture,
        }),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(creatorGalleryMediaTable.id, mediaId),
          eq(creatorGalleryMediaTable.creatorId, creatorId)
        )
      );

    await this.touchCreator(creatorId);

    return this.findGalleryMediaById(creatorId, mediaId);
  }

  private async findSocialLinkById(id: number): Promise<SocialLink> {
    const link = await db
      .select()
      .from(creatorSocialLinksTable)
      .where(eq(creatorSocialLinksTable.id, id))
      .limit(1);

    if (!link || link.length === 0) {
      throw new NotFoundError(`Social link not found with id: ${id}`);
    }

    return this.mapToSnakeCase(link[0]);
  }

  private async findCreatorById(id: number): Promise<Creator> {
    const result = await db.execute(sql`
      SELECT
        c.*,
        profile_media.file_path as unified_profile_picture_path,
        main_media.file_path as unified_main_picture_path
      FROM creators c
      LEFT JOIN LATERAL (
        SELECT file_path FROM creator_gallery_media
        WHERE creator_id = c.id AND is_profile_picture = true
        ORDER BY updated_at DESC, id DESC
        LIMIT 1
      ) profile_media ON true
      LEFT JOIN LATERAL (
        SELECT file_path FROM creator_gallery_media
        WHERE creator_id = c.id AND is_main_picture = true
        ORDER BY updated_at DESC, id DESC
        LIMIT 1
      ) main_media ON true
      WHERE c.id = ${id}
      LIMIT 1
    `);

    if (!result || result.length === 0) {
      throw new NotFoundError(`Creator not found with id: ${id}`);
    }

    return this.mapCreatorToSnakeCase(result[0]);
  }

  private async findGalleryMediaById(
    creatorId: number,
    mediaId: number
  ): Promise<CreatorGalleryMedia> {
    const result = await db
      .select()
      .from(creatorGalleryMediaTable)
      .where(
        and(
          eq(creatorGalleryMediaTable.id, mediaId),
          eq(creatorGalleryMediaTable.creatorId, creatorId)
        )
      )
      .limit(1);

    if (!result[0]) {
      throw new NotFoundError(
        `Creator gallery media not found with id: ${mediaId}`
      );
    }

    return this.mapGalleryMediaToSnakeCase(result[0]);
  }

  private mapToSnakeCase(link: any): SocialLink {
    return {
      id: link.id,
      creator_id: link.creatorId,
      platform_name: link.platformName,
      url: link.url,
      created_at:
        link.createdAt instanceof Date
          ? link.createdAt.toISOString()
          : link.createdAt,
    };
  }

  private mapCreatorToSnakeCase(creator: any): Creator {
    const toISOString = (val: unknown): string => {
      if (val instanceof Date) return val.toISOString();
      if (typeof val === "string") return val;
      return new Date().toISOString();
    };

    return {
      id: creator.id,
      name: creator.name,
      description: creator.description,
      profile_picture_path:
        creator.unified_profile_picture_path ??
        creator.profilePicturePath ??
        creator.profile_picture_path,
      main_picture_path:
        creator.unified_main_picture_path ??
        creator.mainPicturePath ??
        creator.main_picture_path ??
        null,
      face_thumbnail_path:
        creator.faceThumbnailPath ?? creator.face_thumbnail_path ?? null,
      profile_picture_url:
        (creator.unified_profile_picture_path ??
        creator.profilePicturePath ??
        creator.profile_picture_path)
          ? `/api/creators/${creator.id}/picture`
          : undefined,
      main_picture_url:
        (creator.unified_main_picture_path ??
        creator.mainPicturePath ??
        creator.main_picture_path)
          ? `/api/creators/${creator.id}/picture?variant=main`
          : undefined,
      face_thumbnail_url:
        (creator.faceThumbnailPath ?? creator.face_thumbnail_path)
          ? `/api/creators/${creator.id}/picture?type=face`
          : undefined,
      is_favorite: false,
      created_at: toISOString(creator.createdAt ?? creator.created_at),
      updated_at: toISOString(creator.updatedAt ?? creator.updated_at),
    };
  }

  private mapGalleryMediaToSnakeCase(media: any): CreatorGalleryMedia {
    return {
      id: media.id,
      creator_id: media.creatorId,
      label: media.label ?? null,
      description: media.description ?? null,
      file_path: media.filePath,
      is_profile_picture: media.isProfilePicture,
      is_main_picture: media.isMainPicture,
      url: `/api/creators/${media.creatorId}/gallery/${media.id}/image`,
      created_at:
        media.createdAt instanceof Date
          ? media.createdAt.toISOString()
          : media.createdAt,
      updated_at:
        media.updatedAt instanceof Date
          ? media.updatedAt.toISOString()
          : media.updatedAt,
    };
  }

  private normalizeOptionalText(value: string | undefined) {
    const normalized = value?.trim();
    return normalized ? normalized : null;
  }

  private async createGalleryImage(
    creatorId: number,
    filePath: string,
    options: {
      label?: string;
      description?: string;
      isProfilePicture?: boolean;
      isMainPicture?: boolean;
    } = {}
  ) {
    await db.insert(creatorGalleryMediaTable).values({
      creatorId,
      label: this.normalizeOptionalText(options.label),
      description: this.normalizeOptionalText(options.description),
      filePath,
      isProfilePicture: options.isProfilePicture ?? false,
      isMainPicture: options.isMainPicture ?? false,
    });
  }

  private async clearImageRole(creatorId: number, role: CreatorPictureVariant) {
    await db
      .update(creatorGalleryMediaTable)
      .set({
        ...(role === "portrait"
          ? { isProfilePicture: false }
          : { isMainPicture: false }),
        updatedAt: new Date(),
      })
      .where(eq(creatorGalleryMediaTable.creatorId, creatorId));
  }

  private async touchCreator(creatorId: number) {
    await db
      .update(creatorsTable)
      .set({ updatedAt: new Date() })
      .where(eq(creatorsTable.id, creatorId));
  }

  private deleteFileIfExists(filePath: string | null | undefined) {
    if (!filePath || !existsSync(filePath)) {
      return;
    }

    unlinkSync(filePath);
  }

  private async downloadImage(url: string) {
    const buffer = await imageDownloadRateLimiter.schedule(async () => {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(
          `Failed to download image: ${response.status} ${response.statusText}`
        );
      }

      const contentType = response.headers.get("content-type");
      if (!contentType || !contentType.startsWith("image/")) {
        throw new Error("URL does not point to a valid image");
      }

      return Buffer.from(await response.arrayBuffer());
    });

    if (buffer.length < 100) {
      throw new Error("Downloaded image is too small");
    }

    return buffer;
  }

  private async storeProcessedImage(params: {
    input: Buffer;
    namePrefix: string;
    maxSize: number;
  }) {
    if (!existsSync(env.PROFILE_PICTURES_DIR)) {
      mkdirSync(env.PROFILE_PICTURES_DIR, { recursive: true });
    }

    const filePath = join(
      env.PROFILE_PICTURES_DIR,
      `${params.namePrefix}_${Date.now()}.${env.PROFILE_PICTURE_FORMAT}`
    );

    const processedBuffer = await processProfilePicture({
      input: params.input,
      format: env.PROFILE_PICTURE_FORMAT,
      maxSize: params.maxSize,
      quality: env.PROFILE_PICTURE_QUALITY,
    });

    writeFileSync(filePath, processedBuffer);
    return filePath;
  }

  private async generateFaceThumbnail(
    profilePath: string,
    creatorId: number
  ): Promise<string | null> {
    try {
      const faceClient = getFaceRecognitionClient();
      const result = await faceClient.detectFacesFromFile(profilePath);

      if (result.faces.length === 0) {
        return null;
      }

      const bestFace = result.faces.reduce((best, current) =>
        current.det_score > best.det_score ? current : best
      );

      const faceDir = join(env.PROFILE_PICTURES_DIR, "faces");
      if (!existsSync(faceDir)) {
        mkdirSync(faceDir, { recursive: true });
      }

      const faceFilename = `creator_${creatorId}_${Date.now()}_face.${env.FACE_THUMBNAIL_FORMAT}`;
      const facePath = join(faceDir, faceFilename);

      const { outputPath } = await cropFaceThumbnail({
        inputPath: profilePath,
        outputPath: facePath,
        faceBox: bestFace.bbox,
        imageWidth: result.image_width,
        imageHeight: result.image_height,
      });

      return outputPath;
    } catch (error) {
      logger.warn({ error, creatorId }, "Failed to generate face thumbnail");
      return null;
    }
  }

  private async generateProfilePictureEmbedding(
    profilePath: string,
    creatorId: number
  ): Promise<void> {
    try {
      const existingEmbedding = await db
        .select({ id: creatorFaceEmbeddingsTable.id })
        .from(creatorFaceEmbeddingsTable)
        .where(eq(creatorFaceEmbeddingsTable.creatorId, creatorId))
        .limit(1);

      const faceService = getFaceRecognitionService();

      await faceService.addCreatorEmbedding({
        creatorId,
        imagePath: profilePath,
        sourceType: "profile_picture",
        isPrimary: existingEmbedding.length === 0,
      });
    } catch (error) {
      logger.warn(
        { error, creatorId },
        "Failed to generate profile picture embedding"
      );
    }
  }
}

export const creatorsSocialService = new CreatorsSocialService();
