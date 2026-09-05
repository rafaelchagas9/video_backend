import { eq, sql, like, desc, inArray, or, asc } from "drizzle-orm";
import { db } from "@/config/drizzle";
import { env } from "@/config/env";
import { studioAliasesTable, studiosTable, videoStudiosTable } from "@/database/schema";
import { demoSchema, getDemoDatabase, getDemoSqlite } from "@/database/demo";
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
  StudioInclude,
} from "./studios.types";
import { studiosDemoService } from "./studios.demo.service";
import { studioAssignmentService } from "./studio-assignment.service";

export class StudiosService {
  // Basic CRUD Operations
  async list(options: ListStudiosOptions = {}): Promise<PaginatedStudios> {
    if (env.DEMO_MODE) {
      return this.listDemo(options);
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
      whereConditions.push(sql`(
        s.name ILIKE ${`%${search}%`}
        OR EXISTS (
          SELECT 1 FROM studio_aliases sia
          WHERE sia.studio_id = s.id
            AND sia.name ILIKE ${`%${search}%`}
        )
      )`);
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
      data: await this.attachIncludes(studios, options.include ?? []),
      pagination: {
        page,
        limit,
        total: Number(total),
        totalPages: Number(totalPages),
      },
    };
  }

  private async listDemo(
    options: ListStudiosOptions
  ): Promise<PaginatedStudios> {
    const page = options.page ?? 1;
    const limit = options.limit ?? 20;
    const offset = (page - 1) * limit;
    const conditions: string[] = [];
    const params: Array<string | number> = [];

    if (options.search) {
      const pattern = `%${options.search}%`;
      conditions.push(`(
        lower(s.name) LIKE lower(?)
        OR EXISTS (
          SELECT 1 FROM demo_studio_aliases sia
          WHERE sia.studio_id = s.id AND lower(sia.name) LIKE lower(?)
        )
      )`);
      params.push(pattern, pattern);
    }
    if (options.missing) {
      const missingConditions = {
        picture: "s.profile_picture_path IS NULL",
        social: "COALESCE(slc.social_link_count, 0) = 0",
        linked:
          "COALESCE(vc.video_count, 0) = 0 AND COALESCE(cc.creator_count, 0) = 0",
        any: `(
          s.profile_picture_path IS NULL
          OR COALESCE(slc.social_link_count, 0) = 0
          OR (COALESCE(vc.video_count, 0) = 0 AND COALESCE(cc.creator_count, 0) = 0)
        )`,
      } as const;
      conditions.push(missingConditions[options.missing]);
    }
    if (options.complete !== undefined) {
      const completeCondition = `(
        s.profile_picture_path IS NOT NULL
        AND COALESCE(slc.social_link_count, 0) > 0
        AND (COALESCE(vc.video_count, 0) > 0 OR COALESCE(cc.creator_count, 0) > 0)
      )`;
      conditions.push(options.complete ? completeCondition : `NOT ${completeCondition}`);
    }

    const joins = `
      FROM demo_studios s
      LEFT JOIN (
        SELECT studio_id, COUNT(*) AS social_link_count
        FROM demo_studio_social_links GROUP BY studio_id
      ) slc ON s.id = slc.studio_id
      LEFT JOIN (
        SELECT studio_id, COUNT(*) AS video_count
        FROM demo_video_studios GROUP BY studio_id
      ) vc ON s.id = vc.studio_id
      LEFT JOIN (
        SELECT studio_id, COUNT(*) AS creator_count
        FROM demo_creator_studios GROUP BY studio_id
      ) cc ON s.id = cc.studio_id
    `;
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const sortExpressions = {
      name: "s.name",
      created_at: "s.created_at",
      updated_at: "s.updated_at",
      video_count: "COALESCE(vc.video_count, 0)",
      creator_count: "COALESCE(cc.creator_count, 0)",
    } as const;
    const sort = options.sort ?? "name";
    const direction = options.order === "desc" ? "DESC" : "ASC";
    const sqlite = getDemoSqlite();
    const countRow = sqlite
      .query<{ count: number }, Array<string | number>>(
        `SELECT COUNT(*) AS count ${joins} ${where}`
      )
      .get(...params);
    const rows = sqlite
      .query<Record<string, unknown>, Array<string | number>>(`
        SELECT
          s.id, s.name, s.description, s.profile_picture_path,
          s.created_at, s.updated_at,
          COALESCE(slc.social_link_count, 0) AS social_link_count,
          COALESCE(vc.video_count, 0) AS linked_video_count,
          COALESCE(cc.creator_count, 0) AS linked_creator_count
        ${joins}
        ${where}
        ORDER BY ${sortExpressions[sort]} ${direction}, s.id ASC
        LIMIT ? OFFSET ?
      `)
      .all(...params, limit, offset);
    const data = rows.map((row) => {
      const hasPicture = row.profile_picture_path !== null;
      const hasSocial = Number(row.social_link_count) > 0;
      const hasLinked =
        Number(row.linked_video_count) > 0 ||
        Number(row.linked_creator_count) > 0;
      return {
        id: Number(row.id),
        name: String(row.name),
        description: row.description === null ? null : String(row.description),
        profile_picture_path:
          row.profile_picture_path === null
            ? null
            : String(row.profile_picture_path),
        created_at: String(row.created_at),
        updated_at: String(row.updated_at),
        social_link_count: Number(row.social_link_count),
        linked_video_count: Number(row.linked_video_count),
        linked_creator_count: Number(row.linked_creator_count),
        has_profile_picture: hasPicture,
        completeness: {
          is_complete: hasPicture && hasSocial && hasLinked,
          missing_fields: [
            ...(!hasPicture ? ["picture"] : []),
            ...(!hasSocial ? ["social"] : []),
            ...(!hasLinked ? ["linked"] : []),
          ],
        },
      };
    });
    const total = Number(countRow?.count ?? 0);
    return {
      data: await this.attachIncludes(data, options.include ?? []),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async findById(id: number, include: StudioInclude[] = []): Promise<Studio> {
    if (env.DEMO_MODE) {
      const [studio] = await this.attachIncludes(
        [studiosDemoService.findById(id)],
        include
      );
      return studio;
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

    const [result] = await this.attachIncludes(
      [this.mapToSnakeCase(studio)],
      include
    );
    return result;
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

    await db.transaction(async (tx) => {
      const affected = await tx.select({ videoId: videoStudiosTable.videoId })
        .from(videoStudiosTable).where(eq(videoStudiosTable.studioId, id));
      await studioAssignmentService.unlinkMany(affected.map((row) => row.videoId), [id], tx);
      await tx.delete(studiosTable).where(eq(studiosTable.id, id));
    });

    // Enrichment suggestions/runs are polymorphic (no FK) — clean up explicitly.
    const { enrichmentService } =
      await import("@/modules/enrichment/enrichment.service");
    await enrichmentService.deleteForEntity("studio", id);
  }

  async autocomplete(query: string, limit: number = 10): Promise<Studio[]> {
    if (env.DEMO_MODE) {
      const { demoRepository } = await import("@/database/demo/repository");
      const list = demoRepository.getStudios({ search: query, limit }).data;
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
      const { demoRepository } = await import("@/database/demo/repository");
      const list = demoRepository.getStudios({ limit }).data;
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

  private async attachIncludes<T extends Studio>(
    studios: T[],
    include: StudioInclude[]
  ): Promise<T[]> {
    if (studios.length === 0 || include.length === 0) return studios;
    const ids = studios.map((studio) => studio.id);
    const wantsHierarchy = include.includes("hierarchy");
    const wantsAliases = include.includes("aliases");

    const assignments = !wantsHierarchy
      ? []
      : env.DEMO_MODE
        ? getDemoDatabase()
            .select({
              id: demoSchema.demoStudiosTable.id,
              parentId: demoSchema.demoStudiosTable.parentStudioId,
            })
            .from(demoSchema.demoStudiosTable)
            .where(inArray(demoSchema.demoStudiosTable.id, ids))
            .all()
        : await db
            .select({ id: studiosTable.id, parentId: studiosTable.parentStudioId })
            .from(studiosTable)
            .where(inArray(studiosTable.id, ids));
    const parentIds = assignments.flatMap((row) =>
      row.parentId === null || row.parentId === row.id ? [] : [row.parentId]
    );
    const related = !wantsHierarchy
      ? []
      : env.DEMO_MODE
        ? getDemoDatabase()
            .select({
              id: demoSchema.demoStudiosTable.id,
              name: demoSchema.demoStudiosTable.name,
              parentId: demoSchema.demoStudiosTable.parentStudioId,
            })
            .from(demoSchema.demoStudiosTable)
            .where(or(
              parentIds.length > 0
                ? inArray(demoSchema.demoStudiosTable.id, parentIds)
                : sql`0 = 1`,
              inArray(demoSchema.demoStudiosTable.parentStudioId, ids)
            ))
            .orderBy(asc(demoSchema.demoStudiosTable.name))
            .all()
        : await db
            .select({
              id: studiosTable.id,
              name: studiosTable.name,
              parentId: studiosTable.parentStudioId,
            })
            .from(studiosTable)
            .where(or(
              parentIds.length > 0
                ? inArray(studiosTable.id, parentIds)
                : sql`false`,
              inArray(studiosTable.parentStudioId, ids)
            ))
            .orderBy(studiosTable.name);
    const aliases = !wantsAliases
      ? []
      : env.DEMO_MODE
        ? getDemoDatabase()
            .select()
            .from(demoSchema.demoStudioAliasesTable)
            .where(inArray(demoSchema.demoStudioAliasesTable.studioId, ids))
            .orderBy(asc(demoSchema.demoStudioAliasesTable.name))
            .all()
        : await db
            .select()
            .from(studioAliasesTable)
            .where(inArray(studioAliasesTable.studioId, ids))
            .orderBy(studioAliasesTable.name);

    return studios.map((studio) => {
      const assignment = assignments.find((row) => row.id === studio.id);
      const parentCandidate = related.find(
        (row) => row.id === assignment?.parentId && row.id !== studio.id
      );
      const parent =
        parentCandidate?.parentId === studio.id ? undefined : parentCandidate;
      const children = related
        .filter(
          (row) =>
            row.parentId === studio.id &&
            row.id !== studio.id &&
            row.id !== assignment?.parentId
        )
        .map((row) => ({ id: row.id, name: row.name }));
      return {
        ...studio,
        ...(wantsHierarchy
          ? {
              parent: parent ? { id: parent.id, name: parent.name } : null,
              children,
            }
          : {}),
        ...(wantsAliases
          ? {
              aliases: aliases
                .filter((alias) => alias.studioId === studio.id)
                .map((alias) => ({
                  id: alias.id,
                  name: alias.name,
                  note: alias.note,
                })),
            }
          : {}),
      };
    });
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
