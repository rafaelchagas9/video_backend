import { eq, and } from "drizzle-orm";
import { db } from "@/config/drizzle";
import { studiosTable, studioSocialLinksTable } from "@/database/schema";
import { NotFoundError } from "@/utils/errors";
import { env } from "@/config/env";
import { mkdir, open, unlink } from "fs/promises";
import { randomUUID } from "crypto";
import { logger } from "@/utils/logger";
import { join } from "path";
import { processProfilePicture } from "@/utils/image-processing";
import { downloadRemoteImage } from "@/utils/remote-image-download";
import type {
  Studio,
  StudioSocialLink,
  CreateStudioSocialLinkInput,
  UpdateStudioSocialLinkInput,
  BulkStudioSocialLinkItem,
  BulkOperationResult,
} from "./studios.types";
import { studiosDemoService } from "./studios.demo.service";
import { demoMediaAssetsService } from "@/modules/media/demo-media-assets.service";

export class StudiosSocialService {
  // Profile Picture Methods
  async uploadProfilePicture(
    id: number,
    fileBuffer: Buffer,
    _filename: string
  ): Promise<Studio> {
    if (env.DEMO_MODE)
      return demoMediaAssetsService.uploadStudioPicture(id, fileBuffer);
    const studio = await this.findStudioById(id);

    const processedBuffer = await processProfilePicture({
      input: fileBuffer,
      format: env.PROFILE_PICTURE_FORMAT,
      maxSize: env.PROFILE_PICTURE_MAX_SIZE,
      quality: env.PROFILE_PICTURE_QUALITY,
    });
    await mkdir(env.PROFILE_PICTURES_DIR, { recursive: true });
    const filePath = join(
      env.PROFILE_PICTURES_DIR,
      `studio_${id}_${randomUUID()}.${env.PROFILE_PICTURE_FORMAT}`
    );

    // Own a new file before writing so failure cleanup cannot remove an existing asset.
    const candidate = await open(filePath, "wx");
    let updatedStudio;
    try {
      try {
        await candidate.writeFile(processedBuffer);
      } finally {
        await candidate.close();
      }
      [updatedStudio] = await db
        .update(studiosTable)
        .set({ profilePicturePath: filePath, updatedAt: new Date() })
        .where(eq(studiosTable.id, id))
        .returning();
      if (!updatedStudio) {
        throw new NotFoundError(`Studio not found with id: ${id}`);
      }
    } catch (error) {
      await this.cleanupPicture(filePath, id);
      throw error;
    }

    // The database now points to the replacement; old-file cleanup is best effort.
    if (studio.profile_picture_path) {
      await this.cleanupPicture(studio.profile_picture_path, id);
    }
    return this.mapStudioToSnakeCase(updatedStudio);
  }

  private async cleanupPicture(
    filePath: string,
    studioId: number
  ): Promise<void> {
    try {
      await unlink(filePath);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return;
      }
      logger.warn(
        { err: error, studioId },
        "Failed to clean up studio picture"
      );
    }
  }

  async deleteProfilePicture(id: number): Promise<Studio> {
    if (env.DEMO_MODE) return demoMediaAssetsService.deleteStudioPicture(id);
    const studio = await this.findStudioById(id);

    const [updatedStudio] = await db
      .update(studiosTable)
      .set({ profilePicturePath: null, updatedAt: new Date() })
      .where(eq(studiosTable.id, id))
      .returning();
    if (!updatedStudio) {
      throw new NotFoundError(`Studio not found with id: ${id}`);
    }

    if (studio.profile_picture_path) {
      await this.cleanupPicture(studio.profile_picture_path, id);
    }
    return this.mapStudioToSnakeCase(updatedStudio);
  }

  async setPictureFromUrl(studioId: number, url: string): Promise<Studio> {
    if (env.DEMO_MODE)
      return demoMediaAssetsService.setStudioPictureFromUrl(studioId, url);
    await this.findStudioById(studioId);

    const buffer = await downloadRemoteImage(url);

    return this.uploadProfilePicture(studioId, buffer, "download");
  }

  // Social Links Methods
  async addSocialLink(
    studioId: number,
    input: CreateStudioSocialLinkInput
  ): Promise<StudioSocialLink> {
    if (env.DEMO_MODE) return studiosDemoService.addSocialLink(studioId, input);
    await this.findStudioById(studioId); // Ensure studio exists

    const result = await db
      .insert(studioSocialLinksTable)
      .values({
        studioId,
        platformName: input.platform_name,
        url: input.url,
      })
      .returning({ id: studioSocialLinksTable.id })
      .then((rows) => rows[0]);

    if (!result) {
      throw new Error("Failed to create social link");
    }

    return this.findSocialLinkById(result.id);
  }

  async updateSocialLink(
    id: number,
    input: UpdateStudioSocialLinkInput,
    studioId: number
  ): Promise<StudioSocialLink> {
    if (env.DEMO_MODE) {
      if (studioId === undefined)
        throw new NotFoundError(`Studio social link not found with id: ${id}`);
      return studiosDemoService.updateSocialLink(studioId, id, input);
    }
    await this.findSocialLinkById(id, studioId); // Ensure exists

    const updates: any = {};

    if (input.platform_name !== undefined) {
      updates.platformName = input.platform_name;
    }

    if (input.url !== undefined) {
      updates.url = input.url;
    }

    if (Object.keys(updates).length === 0) {
      return this.findSocialLinkById(id, studioId);
    }

    await db
      .update(studioSocialLinksTable)
      .set(updates)
      .where(
        and(
          eq(studioSocialLinksTable.id, id),
          eq(studioSocialLinksTable.studioId, studioId)
        )
      );

    return this.findSocialLinkById(id, studioId);
  }

  async deleteSocialLink(id: number, studioId: number): Promise<void> {
    if (env.DEMO_MODE) {
      if (studioId === undefined)
        throw new NotFoundError(`Studio social link not found with id: ${id}`);
      studiosDemoService.deleteSocialLink(studioId, id);
      return;
    }
    await this.findSocialLinkById(id, studioId); // Ensure exists
    await db
      .delete(studioSocialLinksTable)
      .where(
        and(
          eq(studioSocialLinksTable.id, id),
          eq(studioSocialLinksTable.studioId, studioId)
        )
      );
  }

  async getSocialLinks(studioId: number): Promise<StudioSocialLink[]> {
    if (env.DEMO_MODE) {
      return studiosDemoService.listSocialLinks(studioId);
    }

    await this.findStudioById(studioId); // Ensure studio exists

    const links = await db
      .select()
      .from(studioSocialLinksTable)
      .where(eq(studioSocialLinksTable.studioId, studioId))
      .orderBy(studioSocialLinksTable.platformName);

    return links.map(this.mapSocialLinkToSnakeCase);
  }

  async bulkUpsertSocialLinks(
    studioId: number,
    items: BulkStudioSocialLinkItem[]
  ): Promise<BulkOperationResult<StudioSocialLink>> {
    if (env.DEMO_MODE) {
      const created: StudioSocialLink[] = [];
      const updated: StudioSocialLink[] = [];
      const errors: Array<{ index: number; error: string }> = [];
      const existing = studiosDemoService.listSocialLinks(studioId);
      for (let index = 0; index < items.length; index++) {
        const item = items[index];
        try {
          const match = existing.find(
            (link) => link.platform_name === item.platform_name
          );
          if (match)
            updated.push(
              studiosDemoService.updateSocialLink(studioId, match.id, item)
            );
          else created.push(studiosDemoService.addSocialLink(studioId, item));
        } catch (error) {
          errors.push({
            index,
            error: error instanceof Error ? error.message : "Unknown error",
          });
        }
      }
      return { created, updated, errors };
    }
    await this.findStudioById(studioId); // Ensure studio exists

    const created: StudioSocialLink[] = [];
    const updated: StudioSocialLink[] = [];
    const errors: Array<{ index: number; error: string }> = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      try {
        // Check if exists by platform_name + url
        const existing = await db
          .select({ id: studioSocialLinksTable.id })
          .from(studioSocialLinksTable)
          .where(
            and(
              eq(studioSocialLinksTable.studioId, studioId),
              eq(studioSocialLinksTable.platformName, item.platform_name),
              eq(studioSocialLinksTable.url, item.url)
            )
          )
          .limit(1)
          .then((rows) => rows[0] || null);

        if (existing) {
          // Already exists with same data, add to updated
          updated.push(await this.findSocialLinkById(existing.id));
        } else {
          // Check if exists by platform_name only (update url)
          const existingByPlatform = await db
            .select({ id: studioSocialLinksTable.id })
            .from(studioSocialLinksTable)
            .where(
              and(
                eq(studioSocialLinksTable.studioId, studioId),
                eq(studioSocialLinksTable.platformName, item.platform_name)
              )
            )
            .limit(1)
            .then((rows) => rows[0] || null);

          if (existingByPlatform) {
            // Update URL
            await db
              .update(studioSocialLinksTable)
              .set({ url: item.url })
              .where(eq(studioSocialLinksTable.id, existingByPlatform.id));
            updated.push(await this.findSocialLinkById(existingByPlatform.id));
          } else {
            // Create new
            const result = await db
              .insert(studioSocialLinksTable)
              .values({
                studioId,
                platformName: item.platform_name,
                url: item.url,
              })
              .returning({ id: studioSocialLinksTable.id })
              .then((rows) => rows[0]);

            if (result) {
              created.push(await this.findSocialLinkById(result.id));
            }
          }
        }
      } catch (error: any) {
        errors.push({ index: i, error: error.message || "Unknown error" });
      }
    }

    return { created, updated, errors };
  }

  // Helper methods
  private async findStudioById(id: number): Promise<Studio> {
    const studio = await db
      .select()
      .from(studiosTable)
      .where(eq(studiosTable.id, id))
      .limit(1)
      .then((rows) => rows[0] || null);

    if (!studio) {
      throw new NotFoundError(`Studio not found with id: ${id}`);
    }

    return this.mapStudioToSnakeCase(studio);
  }

  private async findSocialLinkById(
    id: number,
    studioId?: number
  ): Promise<StudioSocialLink> {
    const link = await db
      .select()
      .from(studioSocialLinksTable)
      .where(
        and(
          eq(studioSocialLinksTable.id, id),
          studioId === undefined
            ? undefined
            : eq(studioSocialLinksTable.studioId, studioId)
        )
      )
      .limit(1)
      .then((rows) => rows[0] || null);

    if (!link) {
      throw new NotFoundError(`Social link not found with id: ${id}`);
    }

    return this.mapSocialLinkToSnakeCase(link);
  }

  private mapStudioToSnakeCase(studio: any): Studio {
    return {
      id: studio.id,
      name: studio.name,
      description: studio.description,
      profile_picture_path: studio.profilePicturePath,
      created_at: studio.createdAt.toISOString(),
      updated_at: studio.updatedAt.toISOString(),
    };
  }

  private mapSocialLinkToSnakeCase(link: any): StudioSocialLink {
    return {
      id: link.id,
      studio_id: link.studioId,
      platform_name: link.platformName,
      url: link.url,
      created_at: link.createdAt.toISOString(),
    };
  }
}

export const studiosSocialService = new StudiosSocialService();
