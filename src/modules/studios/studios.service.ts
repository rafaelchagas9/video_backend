import { eq, sql, like, desc } from "drizzle-orm";
import { db } from "@/config/drizzle";
import { env } from "@/config/env";
import { studiosTable } from "@/database/schema";
import {
  NotFoundError,
  ConflictError,
  isUniqueViolation,
} from "@/utils/errors";
import { logger } from "@/utils/logger";
import { existsSync, unlinkSync } from "fs";
import type {
  Studio,
  CreateStudioInput,
  UpdateStudioInput,
  ListStudiosOptions,
  PaginatedStudios,
} from "./studios.types";
import { studiosDemoService } from "./studios.demo.service";

export class StudiosService {
  // Basic CRUD Operations
  async list(options: ListStudiosOptions = {}): Promise<PaginatedStudios> {
    if (env.DEMO_MODE) {
      const { demoMockService } = await import("@/utils/demo-mock");
      return demoMockService.getStudios(options) as PaginatedStudios;
    }
    const {
      page = 1,
      limit = 20,
      search,
      sort = "name",
      order = "asc",
      missing,
      complete,
    } = options;

    const offset = (page - 1) * limit;

    const whereConditions: any[] = [];

    if (search) {
      whereConditions.push(sql`s.name ILIKE ${`%${search}%`}`);
    }

    if (missing) {
      switch (missing) {
        case "picture":
          whereConditions.push(sql`s.profile_picture_path IS NULL`);
          break;
        case "social":
          whereConditions.push(sql`COALESCE(slc.social_link_count, 0) = 0`);
          break;
        case "linked":
          whereConditions.push(
            sql`(COALESCE(vc.video_count, 0) = 0 AND COALESCE(cc.creator_count, 0) = 0)`
          );
          break;
        case "any":
          whereConditions.push(sql`(
            s.profile_picture_path IS NULL
            OR COALESCE(slc.social_link_count, 0) = 0
            OR (COALESCE(vc.video_count, 0) = 0 AND COALESCE(cc.creator_count, 0) = 0)
          )`);
          break;
      }
    }

    if (complete !== undefined) {
      const completenessCondition = sql`(
        s.profile_picture_path IS NOT NULL
        AND COALESCE(slc.social_link_count, 0) > 0
        AND (COALESCE(vc.video_count, 0) > 0 OR COALESCE(cc.creator_count, 0) > 0)
      )`;

      if (complete) {
        whereConditions.push(completenessCondition);
      } else {
        whereConditions.push(sql`NOT ${completenessCondition}`);
      }
    }

    const whereClause =
      whereConditions.length > 0
        ? sql`WHERE ${sql.join(whereConditions, sql` AND `)}`
        : sql``;

    const countQuery = sql`
      SELECT COUNT(*) as count
      FROM studios s
      LEFT JOIN (
        SELECT studio_id, COUNT(*) as social_link_count
        FROM studio_social_links
        GROUP BY studio_id
      ) slc ON s.id = slc.studio_id
      LEFT JOIN (
        SELECT studio_id, COUNT(*) as video_count
        FROM video_studios
        GROUP BY studio_id
      ) vc ON s.id = vc.studio_id
      LEFT JOIN (
        SELECT studio_id, COUNT(*) as creator_count
        FROM creator_studios
        GROUP BY studio_id
      ) cc ON s.id = cc.studio_id
      ${whereClause}
    `;

    const countResult = await db.execute(countQuery);
    const countRows = Array.isArray(countResult) ? countResult : [];
    const total = Number(countRows[0]?.count || 0);
    const totalPages = Math.ceil(total / limit);

    // Map sort column
    const validSortColumns = [
      "name",
      "created_at",
      "updated_at",
      "video_count",
      "creator_count",
    ];
    const sortColumn = validSortColumns.includes(sort) ? sort : "name";

    let sortExpression;
    if (sortColumn === "video_count") {
      sortExpression = sql`COALESCE(vc.video_count, 0)`;
    } else if (sortColumn === "creator_count") {
      sortExpression = sql`COALESCE(cc.creator_count, 0)`;
    } else if (sortColumn === "created_at") {
      sortExpression = sql`s.created_at`;
    } else if (sortColumn === "updated_at") {
      sortExpression = sql`s.updated_at`;
    } else {
      sortExpression = sql`s.name`;
    }

    const sortDir = order === "asc" ? sql`ASC` : sql`DESC`;

    const selectQuery = sql`
      SELECT
        s.id,
        s.name,
        s.description,
        s.profile_picture_path,
        s.created_at,
        s.updated_at,
        COALESCE(slc.social_link_count, 0) as social_link_count,
        COALESCE(vc.video_count, 0) as linked_video_count,
        COALESCE(cc.creator_count, 0) as linked_creator_count
      FROM studios s
      LEFT JOIN (
        SELECT studio_id, COUNT(*) as social_link_count
        FROM studio_social_links
        GROUP BY studio_id
      ) slc ON s.id = slc.studio_id
      LEFT JOIN (
        SELECT studio_id, COUNT(*) as video_count
        FROM video_studios
        GROUP BY studio_id
      ) vc ON s.id = vc.studio_id
      LEFT JOIN (
        SELECT studio_id, COUNT(*) as creator_count
        FROM creator_studios
        GROUP BY studio_id
      ) cc ON s.id = cc.studio_id
      ${whereClause}
      ORDER BY ${sortExpression} ${sortDir}
      LIMIT ${limit} OFFSET ${offset}
    `;

    const rawStudios = await db.execute(selectQuery);
    const studiosArray = Array.isArray(rawStudios) ? rawStudios : [];

    // Compute completeness for each studio
    const studios = studiosArray.map((studio: any) => {
      const hasPicture = studio.profile_picture_path !== null;
      const hasSocial = Number(studio.social_link_count) > 0;
      const hasLinked =
        Number(studio.linked_video_count) > 0 ||
        Number(studio.linked_creator_count) > 0;

      const missingFields: string[] = [];
      if (!hasPicture) missingFields.push("picture");
      if (!hasSocial) missingFields.push("social");
      if (!hasLinked) missingFields.push("linked");

      return {
        id: studio.id,
        name: studio.name,
        description: studio.description,
        profile_picture_path: studio.profile_picture_path,
        created_at:
          studio.created_at instanceof Date
            ? studio.created_at.toISOString()
            : studio.created_at,
        updated_at:
          studio.updated_at instanceof Date
            ? studio.updated_at.toISOString()
            : studio.updated_at,
        social_link_count: Number(studio.social_link_count),
        linked_video_count: Number(studio.linked_video_count),
        linked_creator_count: Number(studio.linked_creator_count),
        has_profile_picture: hasPicture,
        completeness: {
          is_complete: hasPicture && hasSocial && hasLinked,
          missing_fields: missingFields,
        },
      };
    });

    return {
      data: studios,
      pagination: {
        page,
        limit,
        total: Number(total),
        totalPages: Number(totalPages),
      },
    };
  }

  async findById(id: number): Promise<Studio> {
    if (env.DEMO_MODE) {
      return studiosDemoService.findById(id);
    }
    const studio = await db
      .select()
      .from(studiosTable)
      .where(eq(studiosTable.id, id))
      .limit(1)
      .then((rows) => rows[0] || null);

    if (!studio) {
      throw new NotFoundError(`Studio not found with id: ${id}`);
    }

    return this.mapToSnakeCase(studio);
  }

  async create(input: CreateStudioInput): Promise<Studio> {
    if (env.DEMO_MODE) {
      return studiosDemoService.create(input);
    }

    try {
      const result = await db
        .insert(studiosTable)
        .values({
          name: input.name,
          description: input.description || null,
        })
        .returning({ id: studiosTable.id })
        .then((rows) => rows[0]);

      if (!result) {
        throw new Error("Failed to create studio");
      }

      return this.findById(result.id);
    } catch (error: any) {
      if (isUniqueViolation(error)) {
        // PostgreSQL UNIQUE violation
        throw new ConflictError(
          `Studio with name "${input.name}" already exists`
        );
      }
      throw error;
    }
  }

  async update(id: number, input: UpdateStudioInput): Promise<Studio> {
    if (env.DEMO_MODE) {
      return studiosDemoService.update(id, input);
    }

    await this.findById(id); // Ensure exists

    const updates: any = {};

    if (input.name !== undefined) {
      updates.name = input.name;
    }

    if (input.description !== undefined) {
      updates.description = input.description;
    }

    if (Object.keys(updates).length === 0) {
      return this.findById(id);
    }

    updates.updatedAt = new Date();

    try {
      await db.update(studiosTable).set(updates).where(eq(studiosTable.id, id));

      return this.findById(id);
    } catch (error: any) {
      if (isUniqueViolation(error)) {
        // PostgreSQL UNIQUE violation
        throw new ConflictError(
          `Studio with name "${input.name}" already exists`
        );
      }
      throw error;
    }
  }

  async delete(id: number): Promise<void> {
    if (env.DEMO_MODE) {
      studiosDemoService.delete(id);
      return;
    }

    const studio = await this.findById(id); // Ensure exists

    // Delete profile picture file if exists
    if (studio.profile_picture_path) {
      try {
        if (existsSync(studio.profile_picture_path)) {
          unlinkSync(studio.profile_picture_path);
        }
      } catch (error) {
        logger.warn(
          { error, path: studio.profile_picture_path },
          "Failed to delete studio profile picture file"
        );
        // Continue with database deletion even if file deletion fails
      }
    }

    await db.delete(studiosTable).where(eq(studiosTable.id, id));

    // Enrichment suggestions/runs are polymorphic (no FK) — clean up explicitly.
    const { enrichmentService } =
      await import("@/modules/enrichment/enrichment.service");
    await enrichmentService.deleteForEntity("studio", id);
  }

  async autocomplete(query: string, limit: number = 10): Promise<Studio[]> {
    if (env.DEMO_MODE) {
      const { demoMockService } = await import("@/utils/demo-mock");
      const list = demoMockService.getStudios({ search: query, limit }).data;
      return list as Studio[];
    }

    if (!query || query.trim().length < 1) {
      return [];
    }

    const searchTerm = `%${query.trim()}%`;

    const studios = await db
      .select()
      .from(studiosTable)
      .where(like(studiosTable.name, searchTerm))
      .orderBy(studiosTable.name)
      .limit(limit);

    return studios.map(this.mapToSnakeCase);
  }

  async getRecent(limit: number = 10): Promise<Studio[]> {
    if (env.DEMO_MODE) {
      const { demoMockService } = await import("@/utils/demo-mock");
      const list = demoMockService.getStudios({ limit }).data;
      return list as Studio[];
    }

    const studios = await db
      .select()
      .from(studiosTable)
      .orderBy(desc(studiosTable.createdAt))
      .limit(limit);

    return studios.map(this.mapToSnakeCase);
  }

  async quickCreate(name: string, description?: string): Promise<Studio> {
    return this.create({ name: name.trim(), description: description?.trim() });
  }

  // Helper to map Drizzle result to snake_case API format
  private mapToSnakeCase(studio: any): Studio {
    return {
      id: studio.id,
      name: studio.name,
      description: studio.description,
      profile_picture_path: studio.profilePicturePath,
      created_at: studio.createdAt.toISOString(),
      updated_at: studio.updatedAt.toISOString(),
    };
  }
}

export const studiosService = new StudiosService();
