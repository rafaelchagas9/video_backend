import { eq, and } from "drizzle-orm";
import { db } from "@/config/drizzle";
import { studiosTable, studioSocialLinksTable } from "@/database/schema";
import { NotFoundError } from "@/utils/errors";
import { env } from "@/config/env";
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import type {
  Studio,
  StudioSocialLink,
  CreateStudioSocialLinkInput,
  UpdateStudioSocialLinkInput,
  BulkStudioSocialLinkItem,
  BulkOperationResult,
} from "./studios.types";

export class StudiosSocialService {
  // Profile Picture Methods
  async uploadProfilePicture(
    id: number,
    fileBuffer: Buffer,
    filename: string,
  ): Promise<Studio> {
    const studio = await this.findStudioById(id);

    // Ensure directory exists
    if (!existsSync(env.PROFILE_PICTURES_DIR)) {
      mkdirSync(env.PROFILE_PICTURES_DIR, { recursive: true });
    }

    // Delete old picture if exists
    if (
      studio.profile_picture_path &&
      existsSync(studio.profile_picture_path)
    ) {
      unlinkSync(studio.profile_picture_path);
    }

    // Generate unique filename
    const ext = filename.split(".").pop() || "jpg";
    const newFilename = `studio_${id}_${Date.now()}.${ext}`;
    const filePath = join(env.PROFILE_PICTURES_DIR, newFilename);

    // Save file
    writeFileSync(filePath, fileBuffer);

    // Update database
    await db
      .update(studiosTable)
      .set({
        profilePicturePath: filePath,
        updatedAt: new Date(),
      })
      .where(eq(studiosTable.id, id));

    return this.findStudioById(id);
  }

  async deleteProfilePicture(id: number): Promise<Studio> {
    const studio = await this.findStudioById(id);

    if (
      studio.profile_picture_path &&
      existsSync(studio.profile_picture_path)
    ) {
      unlinkSync(studio.profile_picture_path);
    }

    await db
      .update(studiosTable)
      .set({
        profilePicturePath: null,
        updatedAt: new Date(),
      })
      .where(eq(studiosTable.id, id));

    return this.findStudioById(id);
  }

  async setPictureFromUrl(studioId: number, url: string): Promise<Studio> {
    const studio = await this.findStudioById(studioId);

    // Download image from URL
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(
        `Failed to download image: ${response.status} ${response.statusText}`,
      );
    }

    const contentType = response.headers.get("content-type");
    if (!contentType || !contentType.startsWith("image/")) {
      throw new Error("URL does not point to a valid image");
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    // Validate minimum size
    if (buffer.length < 100) {
      throw new Error("Downloaded image is too small");
    }

    // Determine extension from content type
    let ext = "jpg";
    if (contentType.includes("png")) ext = "png";
    else if (contentType.includes("webp")) ext = "webp";
    else if (contentType.includes("gif")) ext = "gif";

    // Ensure directory exists
    if (!existsSync(env.PROFILE_PICTURES_DIR)) {
      mkdirSync(env.PROFILE_PICTURES_DIR, { recursive: true });
    }

    // Delete old picture if exists
    if (
      studio.profile_picture_path &&
      existsSync(studio.profile_picture_path)
    ) {
      unlinkSync(studio.profile_picture_path);
    }

    // Generate unique filename
    const newFilename = `studio_${studioId}_${Date.now()}.${ext}`;
    const filePath = join(env.PROFILE_PICTURES_DIR, newFilename);

    // Save file
    writeFileSync(filePath, buffer);

    // Update database
    await db
      .update(studiosTable)
      .set({
        profilePicturePath: filePath,
        updatedAt: new Date(),
      })
      .where(eq(studiosTable.id, studioId));

    return this.findStudioById(studioId);
  }

  // Social Links Methods
  async addSocialLink(
    studioId: number,
    input: CreateStudioSocialLinkInput,
  ): Promise<StudioSocialLink> {
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
  ): Promise<StudioSocialLink> {
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
      .update(studioSocialLinksTable)
      .set(updates)
      .where(eq(studioSocialLinksTable.id, id));

    return this.findSocialLinkById(id);
  }

  async deleteSocialLink(id: number): Promise<void> {
    await this.findSocialLinkById(id); // Ensure exists
    await db
      .delete(studioSocialLinksTable)
      .where(eq(studioSocialLinksTable.id, id));
  }

  async getSocialLinks(studioId: number): Promise<StudioSocialLink[]> {
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
    items: BulkStudioSocialLinkItem[],
  ): Promise<BulkOperationResult<StudioSocialLink>> {
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
              eq(studioSocialLinksTable.url, item.url),
            ),
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
                eq(studioSocialLinksTable.platformName, item.platform_name),
              ),
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

  private async findSocialLinkById(id: number): Promise<StudioSocialLink> {
    const link = await db
      .select()
      .from(studioSocialLinksTable)
      .where(eq(studioSocialLinksTable.id, id))
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
