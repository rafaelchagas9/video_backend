import { eq } from "drizzle-orm";
import { db } from "@/config/drizzle";
import { platformsTable } from "@/database/schema";
import { NotFoundError, ConflictError } from "@/utils/errors";
import type { Platform, CreatePlatformInput } from "./platforms.types";

export class PlatformsService {
  async list(): Promise<Platform[]> {
    const platforms = await db
      .select()
      .from(platformsTable)
      .orderBy(platformsTable.name);

    // Convert to snake_case for API compatibility
    return platforms.map((p) => ({
      id: p.id,
      name: p.name,
      base_url: p.baseUrl,
      created_at: p.createdAt.toISOString(),
    }));
  }

  async findById(id: number): Promise<Platform> {
    const platform = await db
      .select()
      .from(platformsTable)
      .where(eq(platformsTable.id, id))
      .limit(1)
      .then((rows) => rows[0] || null);

    if (!platform) {
      throw new NotFoundError(`Platform not found with id: ${id}`);
    }

    return {
      id: platform.id,
      name: platform.name,
      base_url: platform.baseUrl,
      created_at: platform.createdAt.toISOString(),
    };
  }

  async findByName(name: string): Promise<Platform | undefined> {
    const platform = await db
      .select()
      .from(platformsTable)
      .where(eq(platformsTable.name, name))
      .limit(1)
      .then((rows) => rows[0] || null);

    if (!platform) {
      return undefined;
    }

    return {
      id: platform.id,
      name: platform.name,
      base_url: platform.baseUrl,
      created_at: platform.createdAt.toISOString(),
    };
  }

  async create(input: CreatePlatformInput): Promise<Platform> {
    try {
      const result = await db
        .insert(platformsTable)
        .values({
          name: input.name,
          baseUrl: input.base_url || null,
        })
        .returning({ id: platformsTable.id })
        .then((rows) => rows[0]);

      if (!result) {
        throw new Error("Failed to create platform");
      }

      return this.findById(result.id);
    } catch (error: any) {
      if (error.code === "23505") {
        // PostgreSQL UNIQUE violation
        throw new ConflictError(
          `Platform with name "${input.name}" already exists`,
        );
      }
      throw error;
    }
  }

  async delete(id: number): Promise<void> {
    await this.findById(id); // Ensure exists
    await db.delete(platformsTable).where(eq(platformsTable.id, id));
  }
}

export const platformsService = new PlatformsService();
