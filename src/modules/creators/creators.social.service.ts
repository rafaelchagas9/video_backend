import { eq, and } from "drizzle-orm";
import { db } from "@/config/drizzle";
import { creatorSocialLinksTable, creatorsTable } from "@/database/schema";
import { NotFoundError } from "@/utils/errors";
import { env } from "@/config/env";
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import type {
  SocialLink,
  CreateSocialLinkInput,
  UpdateSocialLinkInput,
  BulkSocialLinkItem,
  BulkOperationResult,
} from "./creators.types";
import type { Creator } from "./creators.types";

export class CreatorsSocialService {
  // Social Links Methods
  async addSocialLink(
    creatorId: number,
    input: CreateSocialLinkInput,
  ): Promise<SocialLink> {
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
  ): Promise<SocialLink> {
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

  async deleteSocialLink(id: number): Promise<void> {
    await this.findSocialLinkById(id); // Ensure exists
    await db
      .delete(creatorSocialLinksTable)
      .where(eq(creatorSocialLinksTable.id, id));
  }

  async getSocialLinks(creatorId: number): Promise<SocialLink[]> {
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
    items: BulkSocialLinkItem[],
  ): Promise<BulkOperationResult<SocialLink>> {
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
              eq(creatorSocialLinksTable.url, item.url),
            ),
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
                eq(creatorSocialLinksTable.platformName, item.platform_name),
              ),
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

  // Profile Picture Methods
  async uploadProfilePicture(
    id: number,
    fileBuffer: Buffer,
    filename: string,
  ): Promise<Creator> {
    const creator = await this.findCreatorById(id);

    // Ensure directory exists
    if (!existsSync(env.PROFILE_PICTURES_DIR)) {
      mkdirSync(env.PROFILE_PICTURES_DIR, { recursive: true });
    }

    // Delete old picture if exists
    if (
      creator.profile_picture_path &&
      existsSync(creator.profile_picture_path)
    ) {
      unlinkSync(creator.profile_picture_path);
    }

    // Generate unique filename
    const ext = filename.split(".").pop() || "jpg";
    const newFilename = `creator_${id}_${Date.now()}.${ext}`;
    const filePath = join(env.PROFILE_PICTURES_DIR, newFilename);

    // Save file
    writeFileSync(filePath, fileBuffer);

    // Update database
    await db
      .update(creatorsTable)
      .set({
        profilePicturePath: filePath,
        updatedAt: new Date(),
      })
      .where(eq(creatorsTable.id, id));

    return this.findCreatorById(id);
  }

  async deleteProfilePicture(id: number): Promise<Creator> {
    const creator = await this.findCreatorById(id);

    if (
      creator.profile_picture_path &&
      existsSync(creator.profile_picture_path)
    ) {
      unlinkSync(creator.profile_picture_path);
    }

    await db
      .update(creatorsTable)
      .set({
        profilePicturePath: null,
        updatedAt: new Date(),
      })
      .where(eq(creatorsTable.id, id));

    return this.findCreatorById(id);
  }

  async setPictureFromUrl(creatorId: number, url: string): Promise<Creator> {
    const creator = await this.findCreatorById(creatorId);

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
      creator.profile_picture_path &&
      existsSync(creator.profile_picture_path)
    ) {
      unlinkSync(creator.profile_picture_path);
    }

    // Generate unique filename
    const newFilename = `creator_${creatorId}_${Date.now()}.${ext}`;
    const filePath = join(env.PROFILE_PICTURES_DIR, newFilename);

    // Save file
    writeFileSync(filePath, buffer);

    // Update database
    await db
      .update(creatorsTable)
      .set({
        profilePicturePath: filePath,
        updatedAt: new Date(),
      })
      .where(eq(creatorsTable.id, creatorId));

    return this.findCreatorById(creatorId);
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
    const result = await db
      .select()
      .from(creatorsTable)
      .where(eq(creatorsTable.id, id))
      .limit(1);

    if (!result || result.length === 0) {
      throw new NotFoundError(`Creator not found with id: ${id}`);
    }

    return this.mapCreatorToSnakeCase(result[0]);
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
    return {
      id: creator.id,
      name: creator.name,
      description: creator.description,
      profile_picture_path: creator.profilePicturePath,
      created_at:
        creator.createdAt instanceof Date
          ? creator.createdAt.toISOString()
          : creator.createdAt,
      updated_at:
        creator.updatedAt instanceof Date
          ? creator.updatedAt.toISOString()
          : creator.updatedAt,
    };
  }
}

export const creatorsSocialService = new CreatorsSocialService();
