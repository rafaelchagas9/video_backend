import { eq, sql } from "drizzle-orm";
import { db } from "@/config/drizzle";
import { creatorsTable } from "@/database/schema";
import { NotFoundError, ConflictError } from "@/utils/errors";
import { logger } from "@/utils/logger";
import { existsSync, unlinkSync } from "fs";
import type {
  Creator,
  CreateCreatorInput,
  UpdateCreatorInput,
  ListCreatorsOptions,
  PaginatedCreators,
  EnhancedCreator,
} from "./creators.types";

export class CreatorsService {
  async list(options: ListCreatorsOptions = {}): Promise<PaginatedCreators> {
    const {
      page = 1,
      limit = 20,
      search,
      sort = "name",
      order = "asc",
      minVideoCount,
      maxVideoCount,
      hasProfilePicture,
      studioIds,
      missing,
      complete,
    } = options;

    const offsetValue = (page - 1) * limit;

    // Build WHERE conditions as SQL fragments
    const whereConditions: any[] = [];

    // Search filter (name OR platform username)
    if (search) {
      const searchPattern = `%${search}%`;
      whereConditions.push(
        sql`(c.name LIKE ${searchPattern} OR cp_search.username LIKE ${searchPattern})`,
      );
    }

    // Profile picture presence
    if (hasProfilePicture === true) {
      whereConditions.push(sql`c.profile_picture_path IS NOT NULL`);
    } else if (hasProfilePicture === false) {
      whereConditions.push(sql`c.profile_picture_path IS NULL`);
    }

    // Video count filters
    if (minVideoCount !== undefined) {
      whereConditions.push(
        sql`COALESCE(vc.video_count, 0) >= ${minVideoCount}`,
      );
    }
    if (maxVideoCount !== undefined) {
      whereConditions.push(
        sql`COALESCE(vc.video_count, 0) <= ${maxVideoCount}`,
      );
    }

    // Studio filter
    if (studioIds && studioIds.length > 0) {
      whereConditions.push(sql`cs.studio_id IN ${studioIds}`);
    }

    // Missing filter
    if (missing) {
      switch (missing) {
        case "picture":
          whereConditions.push(sql`c.profile_picture_path IS NULL`);
          break;
        case "platform":
          whereConditions.push(sql`COALESCE(pc.platform_count, 0) = 0`);
          break;
        case "social":
          whereConditions.push(sql`COALESCE(sc.social_link_count, 0) = 0`);
          break;
        case "linked":
          whereConditions.push(sql`COALESCE(vc.video_count, 0) = 0`);
          break;
        case "any":
          whereConditions.push(sql`(
            c.profile_picture_path IS NULL
            OR (COALESCE(pc.platform_count, 0) = 0 AND COALESCE(sc.social_link_count, 0) = 0)
            OR COALESCE(vc.video_count, 0) = 0
          )`);
          break;
      }
    }

    // Complete filter
    if (complete !== undefined) {
      const completenessCondition = sql`(
        c.profile_picture_path IS NOT NULL
        AND (COALESCE(pc.platform_count, 0) > 0 OR COALESCE(sc.social_link_count, 0) > 0)
        AND COALESCE(vc.video_count, 0) > 0
      )`;

      if (complete) {
        whereConditions.push(completenessCondition);
      } else {
        whereConditions.push(sql`NOT ${completenessCondition}`);
      }
    }

    const needsStudioJoin = studioIds && studioIds.length > 0;
    const needsPlatformSearchJoin = !!search;

    // Build the complete query with conditional JOINs
    const baseFrom = sql`
      FROM creators c
      LEFT JOIN (
        SELECT creator_id, COUNT(*) as video_count
        FROM video_creators
        GROUP BY creator_id
      ) vc ON c.id = vc.creator_id
      LEFT JOIN (
        SELECT creator_id, COUNT(*) as platform_count
        FROM creator_platforms
        GROUP BY creator_id
      ) pc ON c.id = pc.creator_id
      LEFT JOIN (
        SELECT creator_id, COUNT(*) as social_link_count
        FROM creator_social_links
        GROUP BY creator_id
      ) sc ON c.id = sc.creator_id
    `;

    const studioJoin = needsStudioJoin
      ? sql`INNER JOIN creator_studios cs ON c.id = cs.creator_id`
      : sql``;

    const platformSearchJoin = needsPlatformSearchJoin
      ? sql`LEFT JOIN creator_platforms cp_search ON c.id = cp_search.creator_id`
      : sql``;

    const whereClause =
      whereConditions.length > 0
        ? sql`WHERE ${sql.join(whereConditions, sql` AND `)}`
        : sql``;

    const groupByClause =
      needsPlatformSearchJoin || needsStudioJoin ? sql`GROUP BY c.id` : sql``;

    // Get total count
    const countQuery = sql`
      SELECT COUNT(DISTINCT c.id) as count
      ${baseFrom}
      ${studioJoin}
      ${platformSearchJoin}
      ${whereClause}
    `;

    const countResult = await db.execute(countQuery);
    const total = Number((countResult[0] as any)?.count || 0);
    const totalPages = Math.ceil(total / limit);

    // Map sort column to actual column name
    const validSortColumns = [
      "name",
      "created_at",
      "updated_at",
      "video_count",
    ];
    const sortColumn = validSortColumns.includes(sort) ? sort : "name";

    let sortExpression;
    if (sortColumn === "video_count") {
      sortExpression = sql`COALESCE(vc.video_count, 0)`;
    } else if (sortColumn === "created_at") {
      sortExpression = sql`c.created_at`;
    } else if (sortColumn === "updated_at") {
      sortExpression = sql`c.updated_at`;
    } else {
      sortExpression = sql`c.name`;
    }

    const sortDir = order === "asc" ? sql`ASC` : sql`DESC`;

    // Get creators with sorting and pagination
    const selectQuery = sql`
      SELECT
        c.*,
        COALESCE(vc.video_count, 0) as linked_video_count,
        COALESCE(pc.platform_count, 0) as platform_count,
        COALESCE(sc.social_link_count, 0) as social_link_count
      ${baseFrom}
      ${studioJoin}
      ${platformSearchJoin}
      ${whereClause}
      ${groupByClause}
      ORDER BY ${sortExpression} ${sortDir}
      LIMIT ${limit} OFFSET ${offsetValue}
    `;

    const rawCreators = await db.execute(selectQuery);

    // Compute completeness for each creator
    const creators = (rawCreators as any[]).map((creator: any) => {
      const hasPicture = creator.profile_picture_path !== null;
      const hasPlatformOrSocial =
        creator.platform_count > 0 || creator.social_link_count > 0;
      const hasVideos = creator.linked_video_count > 0;

      const missingFields: string[] = [];
      if (!hasPicture) missingFields.push("picture");
      if (!hasPlatformOrSocial) missingFields.push("platform_or_social");
      if (!hasVideos) missingFields.push("linked_videos");

      return this.mapToSnakeCase({
        ...creator,
        has_profile_picture: hasPicture,
        completeness: {
          is_complete: hasPicture && hasPlatformOrSocial && hasVideos,
          missing_fields: missingFields,
        },
      });
    });

    return {
      data: creators,
      pagination: {
        page,
        limit,
        total,
        totalPages,
      },
    };
  }

  async findById(id: number): Promise<Creator> {
    const result = await db
      .select()
      .from(creatorsTable)
      .where(eq(creatorsTable.id, id))
      .limit(1);

    if (!result || result.length === 0) {
      throw new NotFoundError(`Creator not found with id: ${id}`);
    }

    return this.mapToSnakeCase(result[0]);
  }

  async create(input: CreateCreatorInput): Promise<Creator> {
    try {
      const result = await db
        .insert(creatorsTable)
        .values({
          name: input.name,
          description: input.description || null,
        })
        .returning({ id: creatorsTable.id });

      if (!result || result.length === 0) {
        throw new Error("Failed to create creator");
      }

      return this.findById(result[0].id);
    } catch (error: any) {
      if (error.code === "23505") {
        // UNIQUE violation
        throw new ConflictError(
          `Creator with name "${input.name}" already exists`,
        );
      }
      throw error;
    }
  }

  async update(id: number, input: UpdateCreatorInput): Promise<Creator> {
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
      await db
        .update(creatorsTable)
        .set(updates)
        .where(eq(creatorsTable.id, id));

      return this.findById(id);
    } catch (error: any) {
      if (error.code === "23505") {
        // UNIQUE violation
        throw new ConflictError(
          `Creator with name "${input.name}" already exists`,
        );
      }
      throw error;
    }
  }

  async delete(id: number): Promise<void> {
    const creator = await this.findById(id); // Ensure exists

    // Delete profile picture file if exists
    if (creator.profile_picture_path) {
      try {
        if (existsSync(creator.profile_picture_path)) {
          unlinkSync(creator.profile_picture_path);
        }
      } catch (error) {
        logger.warn(
          { error, path: creator.profile_picture_path },
          "Failed to delete creator profile picture file",
        );
        // Continue with database deletion even if file deletion fails
      }
    }

    await db.delete(creatorsTable).where(eq(creatorsTable.id, id));
  }

  async autocomplete(
    query: string,
    limitParam: number = 10,
  ): Promise<EnhancedCreator[]> {
    if (!query || query.trim().length < 1) {
      return [];
    }

    const searchTerm = `%${query.trim()}%`;

    const rawQuery = sql`
      SELECT c.*,
        COALESCE(vc.video_count, 0) as linked_video_count,
        COALESCE(pc.platform_count, 0) as platform_count,
        COALESCE(sc.social_link_count, 0) as social_link_count
      FROM creators c
      LEFT JOIN (
        SELECT creator_id, COUNT(*) as video_count
        FROM video_creators GROUP BY creator_id
      ) vc ON c.id = vc.creator_id
      LEFT JOIN (
        SELECT creator_id, COUNT(*) as platform_count
        FROM creator_platforms GROUP BY creator_id
      ) pc ON c.id = pc.creator_id
      LEFT JOIN (
        SELECT creator_id, COUNT(*) as social_link_count
        FROM creator_social_links GROUP BY creator_id
      ) sc ON c.id = sc.creator_id
      WHERE c.name LIKE ${searchTerm}
      ORDER BY c.name ASC
      LIMIT ${limitParam}
    `;

    const creators = await db.execute(rawQuery);

    return (creators as any[]).map((creator: any) =>
      this.mapToSnakeCase({
        ...creator,
        has_profile_picture: creator.profile_picture_path !== null,
        completeness: {
          is_complete:
            creator.profile_picture_path !== null &&
            (creator.platform_count > 0 || creator.social_link_count > 0) &&
            creator.linked_video_count > 0,
          missing_fields: [
            ...(creator.profile_picture_path ? [] : ["picture"]),
            ...(creator.platform_count > 0 || creator.social_link_count > 0
              ? []
              : ["platform_or_social"]),
            ...(creator.linked_video_count > 0 ? [] : ["linked_videos"]),
          ],
        },
      }),
    ) as EnhancedCreator[];
  }

  async getRecent(limitParam: number = 10): Promise<EnhancedCreator[]> {
    const rawQuery = sql`
      SELECT c.*,
        COALESCE(vc.video_count, 0) as linked_video_count,
        COALESCE(pc.platform_count, 0) as platform_count,
        COALESCE(sc.social_link_count, 0) as social_link_count
      FROM creators c
      LEFT JOIN (
        SELECT creator_id, COUNT(*) as video_count
        FROM video_creators GROUP BY creator_id
      ) vc ON c.id = vc.creator_id
      LEFT JOIN (
        SELECT creator_id, COUNT(*) as platform_count
        FROM creator_platforms GROUP BY creator_id
      ) pc ON c.id = pc.creator_id
      LEFT JOIN (
        SELECT creator_id, COUNT(*) as social_link_count
        FROM creator_social_links GROUP BY creator_id
      ) sc ON c.id = sc.creator_id
      ORDER BY c.created_at DESC
      LIMIT ${limitParam}
    `;

    const creators = await db.execute(rawQuery);

    return (creators as any[]).map((creator: any) =>
      this.mapToSnakeCase({
        ...creator,
        has_profile_picture: creator.profile_picture_path !== null,
        completeness: {
          is_complete:
            creator.profile_picture_path !== null &&
            (creator.platform_count > 0 || creator.social_link_count > 0) &&
            creator.linked_video_count > 0,
          missing_fields: [
            ...(creator.profile_picture_path ? [] : ["picture"]),
            ...(creator.platform_count > 0 || creator.social_link_count > 0
              ? []
              : ["platform_or_social"]),
            ...(creator.linked_video_count > 0 ? [] : ["linked_videos"]),
          ],
        },
      }),
    ) as EnhancedCreator[];
  }

  async quickCreate(name: string, description?: string): Promise<Creator> {
    return this.create({ name: name.trim(), description: description?.trim() });
  }

  // Helper to map Drizzle results (camelCase) to API format (snake_case)
  private mapToSnakeCase(creator: any): any {
    // Helper to convert date to ISO string
    const toISOString = (val: unknown): string => {
      if (val instanceof Date) return val.toISOString();
      if (typeof val === "string") return val;
      return new Date().toISOString();
    };

    return {
      id: Number(creator.id),
      name: creator.name,
      description: creator.description,
      profile_picture_path:
        creator.profilePicturePath ?? creator.profile_picture_path,
      created_at: toISOString(creator.createdAt ?? creator.created_at),
      updated_at: toISOString(creator.updatedAt ?? creator.updated_at),
      // Pass through any additional fields (for enhanced creators)
      ...(creator.linked_video_count !== undefined && {
        linked_video_count: Number(creator.linked_video_count),
      }),
      ...(creator.platform_count !== undefined && {
        platform_count: Number(creator.platform_count),
      }),
      ...(creator.social_link_count !== undefined && {
        social_link_count: Number(creator.social_link_count),
      }),
      ...(creator.has_profile_picture !== undefined && {
        has_profile_picture: creator.has_profile_picture,
      }),
      ...(creator.completeness !== undefined && {
        completeness: creator.completeness,
      }),
    };
  }
}

export const creatorsService = new CreatorsService();
