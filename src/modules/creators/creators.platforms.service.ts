import { eq, and } from "drizzle-orm";
import { db } from "@/config/drizzle";
import {
  creatorPlatformsTable,
  platformsTable,
  creatorsTable,
} from "@/database/schema";
import { NotFoundError, ConflictError } from "@/utils/errors";
import type {
  CreatorPlatform,
  CreateCreatorPlatformInput,
  UpdateCreatorPlatformInput,
} from "@/modules/platforms/platforms.types";
import type { BulkPlatformItem, BulkOperationResult } from "./creators.types";

export class CreatorsPlatformsService {
  async addPlatformProfile(
    creatorId: number,
    input: CreateCreatorPlatformInput,
  ): Promise<CreatorPlatform> {
    // Verify creator exists
    const creator = await db
      .select({ id: creatorsTable.id })
      .from(creatorsTable)
      .where(eq(creatorsTable.id, creatorId))
      .limit(1);

    if (!creator || creator.length === 0) {
      throw new NotFoundError(`Creator not found with id: ${creatorId}`);
    }

    try {
      const result = await db
        .insert(creatorPlatformsTable)
        .values({
          creatorId,
          platformId: input.platform_id,
          username: input.username,
          profileUrl: input.profile_url,
          isPrimary: input.is_primary ?? false,
        })
        .returning({ id: creatorPlatformsTable.id });

      if (!result || result.length === 0) {
        throw new Error("Failed to add platform profile");
      }

      return this.findPlatformProfileById(result[0].id);
    } catch (error: any) {
      if (error.code === "23505") {
        throw new ConflictError(
          "Creator already has a profile on this platform",
        );
      }
      if (error.code === "23503") {
        throw new NotFoundError("Platform not found");
      }
      throw error;
    }
  }

  async updatePlatformProfile(
    id: number,
    input: UpdateCreatorPlatformInput,
  ): Promise<CreatorPlatform> {
    await this.findPlatformProfileById(id); // Ensure exists

    const updates: any = {};

    if (input.username !== undefined) {
      updates.username = input.username;
    }

    if (input.profile_url !== undefined) {
      updates.profileUrl = input.profile_url;
    }

    if (input.is_primary !== undefined) {
      updates.isPrimary = input.is_primary;
    }

    if (Object.keys(updates).length === 0) {
      return this.findPlatformProfileById(id);
    }

    updates.updatedAt = new Date();

    await db
      .update(creatorPlatformsTable)
      .set(updates)
      .where(eq(creatorPlatformsTable.id, id));

    return this.findPlatformProfileById(id);
  }

  async deletePlatformProfile(id: number): Promise<void> {
    await this.findPlatformProfileById(id); // Ensure exists
    await db
      .delete(creatorPlatformsTable)
      .where(eq(creatorPlatformsTable.id, id));
  }

  async getPlatformProfiles(creatorId: number): Promise<CreatorPlatform[]> {
    // Verify creator exists
    const creator = await db
      .select({ id: creatorsTable.id })
      .from(creatorsTable)
      .where(eq(creatorsTable.id, creatorId))
      .limit(1);

    if (!creator || creator.length === 0) {
      throw new NotFoundError(`Creator not found with id: ${creatorId}`);
    }

    const profiles = await db
      .select({
        id: creatorPlatformsTable.id,
        creatorId: creatorPlatformsTable.creatorId,
        platformId: creatorPlatformsTable.platformId,
        username: creatorPlatformsTable.username,
        profileUrl: creatorPlatformsTable.profileUrl,
        isPrimary: creatorPlatformsTable.isPrimary,
        createdAt: creatorPlatformsTable.createdAt,
        updatedAt: creatorPlatformsTable.updatedAt,
        platformName: platformsTable.name,
      })
      .from(creatorPlatformsTable)
      .leftJoin(
        platformsTable,
        eq(creatorPlatformsTable.platformId, platformsTable.id),
      )
      .where(eq(creatorPlatformsTable.creatorId, creatorId))
      .orderBy(creatorPlatformsTable.isPrimary, platformsTable.name);

    return profiles.map(this.mapToSnakeCase);
  }

  async bulkUpsertPlatforms(
    creatorId: number,
    items: BulkPlatformItem[],
  ): Promise<BulkOperationResult<CreatorPlatform>> {
    // Verify creator exists
    const creator = await db
      .select({ id: creatorsTable.id })
      .from(creatorsTable)
      .where(eq(creatorsTable.id, creatorId))
      .limit(1);

    if (!creator || creator.length === 0) {
      throw new NotFoundError(`Creator not found with id: ${creatorId}`);
    }

    const created: CreatorPlatform[] = [];
    const updated: CreatorPlatform[] = [];
    const errors: Array<{ index: number; error: string }> = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      try {
        // Check if exists by platform_id + username
        const existing = await db
          .select({ id: creatorPlatformsTable.id })
          .from(creatorPlatformsTable)
          .where(
            and(
              eq(creatorPlatformsTable.creatorId, creatorId),
              eq(creatorPlatformsTable.platformId, item.platform_id),
              eq(creatorPlatformsTable.username, item.username),
            ),
          )
          .limit(1);

        if (existing && existing.length > 0) {
          // Update existing
          await db
            .update(creatorPlatformsTable)
            .set({
              profileUrl: item.profile_url,
              isPrimary: item.is_primary ?? false,
              updatedAt: new Date(),
            })
            .where(eq(creatorPlatformsTable.id, existing[0].id));

          updated.push(await this.findPlatformProfileById(existing[0].id));
        } else {
          // Create new
          const result = await db
            .insert(creatorPlatformsTable)
            .values({
              creatorId,
              platformId: item.platform_id,
              username: item.username,
              profileUrl: item.profile_url,
              isPrimary: item.is_primary ?? false,
            })
            .returning({ id: creatorPlatformsTable.id });

          if (!result || result.length === 0) {
            throw new Error("Failed to insert platform");
          }

          created.push(await this.findPlatformProfileById(result[0].id));
        }
      } catch (error: any) {
        errors.push({ index: i, error: error.message || "Unknown error" });
      }
    }

    return { created, updated, errors };
  }

  private async findPlatformProfileById(id: number): Promise<CreatorPlatform> {
    const profile = await db
      .select({
        id: creatorPlatformsTable.id,
        creatorId: creatorPlatformsTable.creatorId,
        platformId: creatorPlatformsTable.platformId,
        username: creatorPlatformsTable.username,
        profileUrl: creatorPlatformsTable.profileUrl,
        isPrimary: creatorPlatformsTable.isPrimary,
        createdAt: creatorPlatformsTable.createdAt,
        updatedAt: creatorPlatformsTable.updatedAt,
        platformName: platformsTable.name,
      })
      .from(creatorPlatformsTable)
      .leftJoin(
        platformsTable,
        eq(creatorPlatformsTable.platformId, platformsTable.id),
      )
      .where(eq(creatorPlatformsTable.id, id))
      .limit(1);

    if (!profile || profile.length === 0) {
      throw new NotFoundError(`Platform profile not found with id: ${id}`);
    }

    return this.mapToSnakeCase(profile[0]);
  }

  private mapToSnakeCase(profile: any): CreatorPlatform {
    return {
      id: profile.id,
      creator_id: profile.creatorId,
      platform_id: profile.platformId,
      username: profile.username,
      profile_url: profile.profileUrl,
      is_primary: profile.isPrimary,
      created_at:
        profile.createdAt instanceof Date
          ? profile.createdAt.toISOString()
          : profile.createdAt,
      updated_at:
        profile.updatedAt instanceof Date
          ? profile.updatedAt.toISOString()
          : profile.updatedAt,
      platform_name: profile.platformName ?? undefined,
    };
  }
}

export const creatorsPlatformsService = new CreatorsPlatformsService();
