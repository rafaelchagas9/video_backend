import { eq, sql } from "drizzle-orm";
import { db } from "@/config/drizzle";
import { env } from "@/config/env";
import {
  creatorFavoritesTable,
  creatorGalleryMediaTable,
  creatorsTable,
} from "@/database/schema";
import {
  NotFoundError,
  ConflictError,
  isUniqueViolation,
} from "@/utils/errors";
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
import { creatorsDemoService } from "./creators.demo.service";

export class CreatorsService {
  async list(
    options: ListCreatorsOptions = {},
    userId?: number
  ): Promise<PaginatedCreators> {
    if (env.DEMO_MODE) {
      const { demoRepository } = await import("@/database/demo/repository");
      return demoRepository.getCreators(options) as PaginatedCreators;
    }
    const {
      page = 1,
      limit = 20,
      search,
      sort = "name",
      order = "asc",
      minVideoCount,
      maxVideoCount,
      hasProfilePicture,
      isFavorite,
      studioIds,
      missing,
      complete,
    } = options;

    const offsetValue = (page - 1) * limit;

    // Build WHERE conditions as SQL fragments
    const whereConditions: any[] = [];

    // Search filter (name OR platform username OR alias)
    if (search) {
      const searchPattern = `%${search}%`;
      whereConditions.push(
        sql`(c.name ILIKE ${searchPattern} OR cp_search.username ILIKE ${searchPattern} OR EXISTS (
          SELECT 1 FROM creator_aliases ca_search
          WHERE ca_search.creator_id = c.id AND ca_search.name ILIKE ${searchPattern}
        ))`
      );
    }

    // Profile picture presence
    if (hasProfilePicture === true) {
      whereConditions.push(sql`EXISTS (
        SELECT 1 FROM creator_gallery_media cgm_profile
        WHERE cgm_profile.creator_id = c.id AND cgm_profile.is_profile_picture = true
      )`);
    } else if (hasProfilePicture === false) {
      whereConditions.push(sql`NOT EXISTS (
        SELECT 1 FROM creator_gallery_media cgm_profile
        WHERE cgm_profile.creator_id = c.id AND cgm_profile.is_profile_picture = true
      )`);
    }

    if (isFavorite === true && userId) {
      whereConditions.push(sql`EXISTS (
        SELECT 1
        FROM creator_favorites cf_only
        WHERE cf_only.user_id = ${userId}
          AND cf_only.creator_id = c.id
      )`);
    } else if (isFavorite === true) {
      whereConditions.push(sql`false`);
    }

    // Video count filters
    if (minVideoCount !== undefined) {
      whereConditions.push(
        sql`COALESCE(vc.video_count, 0) >= ${minVideoCount}`
      );
    }
    if (maxVideoCount !== undefined) {
      whereConditions.push(
        sql`COALESCE(vc.video_count, 0) <= ${maxVideoCount}`
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
          whereConditions.push(sql`NOT EXISTS (
            SELECT 1 FROM creator_gallery_media cgm_profile
            WHERE cgm_profile.creator_id = c.id AND cgm_profile.is_profile_picture = true
          )`);
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
            NOT EXISTS (
              SELECT 1 FROM creator_gallery_media cgm_profile
              WHERE cgm_profile.creator_id = c.id AND cgm_profile.is_profile_picture = true
            )
            OR (COALESCE(pc.platform_count, 0) = 0 AND COALESCE(sc.social_link_count, 0) = 0)
            OR COALESCE(vc.video_count, 0) = 0
          )`);
          break;
      }
    }

    // Complete filter
    if (complete !== undefined) {
      const completenessCondition = sql`(
        EXISTS (
          SELECT 1 FROM creator_gallery_media cgm_profile
          WHERE cgm_profile.creator_id = c.id AND cgm_profile.is_profile_picture = true
        )
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

    const groupByClause = sql`GROUP BY c.id, profile_media.file_path, main_media.file_path`;

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
      sortExpression = sql`COALESCE(MAX(vc.video_count), 0)`;
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
        profile_media.file_path as unified_profile_picture_path,
        main_media.file_path as unified_main_picture_path,
        COALESCE(MAX(vc.video_count), 0) as linked_video_count,
        COALESCE(MAX(pc.platform_count), 0) as platform_count,
        COALESCE(MAX(sc.social_link_count), 0) as social_link_count,
        ${this.favoriteSelectSql(userId, sql`c.id`)} as is_favorite
      ${baseFrom}
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
      const hasPicture = creator.unified_profile_picture_path !== null;
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
        has_main_picture: creator.unified_main_picture_path !== null,
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

  async findById(id: number, userId?: number): Promise<Creator> {
    if (env.DEMO_MODE) {
      return creatorsDemoService.findById(id, userId);
    }
    const result = await db.execute(sql`
      SELECT
        c.*,
        profile_media.file_path as unified_profile_picture_path,
        main_media.file_path as unified_main_picture_path,
        ${this.favoriteSelectSql(userId, sql`c.id`)} as is_favorite
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

    const creator = this.mapToSnakeCase(result[0]);
    creator.gallery_media = await this.getGalleryMedia(id);
    return creator;
  }

  async create(input: CreateCreatorInput, userId?: number): Promise<Creator> {
    if (env.DEMO_MODE) {
      return creatorsDemoService.create(input);
    }

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

      return this.findById(result[0].id, userId);
    } catch (error: any) {
      if (isUniqueViolation(error)) {
        // UNIQUE violation
        throw new ConflictError(
          `Creator with name "${input.name}" already exists`
        );
      }
      throw error;
    }
  }

  async update(
    id: number,
    input: UpdateCreatorInput,
    userId?: number
  ): Promise<Creator> {
    if (env.DEMO_MODE) {
      return creatorsDemoService.update(id, input);
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
      return this.findById(id, userId);
    }

    updates.updatedAt = new Date();

    try {
      await db
        .update(creatorsTable)
        .set(updates)
        .where(eq(creatorsTable.id, id));

      return this.findById(id, userId);
    } catch (error: any) {
      if (isUniqueViolation(error)) {
        // UNIQUE violation
        throw new ConflictError(
          `Creator with name "${input.name}" already exists`
        );
      }
      throw error;
    }
  }

  async delete(id: number): Promise<void> {
    if (env.DEMO_MODE) {
      creatorsDemoService.delete(id);
      return;
    }

    const creator = await this.findById(id); // Ensure exists

    if (creator.face_thumbnail_path) {
      try {
        if (existsSync(creator.face_thumbnail_path)) {
          unlinkSync(creator.face_thumbnail_path);
        }
      } catch (error) {
        logger.warn(
          { error, path: creator.face_thumbnail_path },
          "Failed to delete creator face thumbnail file"
        );
      }
    }

    const galleryMedia = await this.getGalleryMedia(id);
    for (const media of galleryMedia) {
      try {
        if (existsSync(media.file_path)) {
          unlinkSync(media.file_path);
        }
      } catch (error) {
        logger.warn(
          { error, path: media.file_path, creatorId: id, mediaId: media.id },
          "Failed to delete creator gallery media file"
        );
      }
    }

    await db.delete(creatorsTable).where(eq(creatorsTable.id, id));

    // Enrichment suggestions/runs are polymorphic (no FK) — clean up explicitly.
    const { enrichmentService } =
      await import("@/modules/enrichment/enrichment.service");
    await enrichmentService.deleteForEntity("creator", id);
  }

  async autocomplete(
    query: string,
    limitParam: number = 10,
    userId?: number
  ): Promise<EnhancedCreator[]> {
    if (env.DEMO_MODE) {
      const { demoRepository } = await import("@/database/demo/repository");
      const listObj = demoRepository.getCreators({
        search: query,
        limit: limitParam,
      });
      return listObj.data as EnhancedCreator[];
    }

    if (!query || query.trim().length < 1) {
      return [];
    }

    const searchTerm = `%${query.trim()}%`;

    const rawQuery = sql`
      SELECT c.*,
        profile_media.file_path as unified_profile_picture_path,
        main_media.file_path as unified_main_picture_path,
        COALESCE(vc.video_count, 0) as linked_video_count,
        COALESCE(pc.platform_count, 0) as platform_count,
        COALESCE(sc.social_link_count, 0) as social_link_count,
        ${this.favoriteSelectSql(userId, sql`c.id`)} as is_favorite
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
      WHERE (c.name ILIKE ${searchTerm} OR EXISTS (
        SELECT 1 FROM creator_aliases ca_search
        WHERE ca_search.creator_id = c.id AND ca_search.name ILIKE ${searchTerm}
      ))
      ORDER BY c.name ASC
      LIMIT ${limitParam}
    `;

    const creators = await db.execute(rawQuery);

    return (creators as any[]).map((creator: any) =>
      this.mapToSnakeCase({
        ...creator,
        has_profile_picture: creator.unified_profile_picture_path !== null,
        has_main_picture: creator.unified_main_picture_path !== null,
        completeness: {
          is_complete:
            creator.unified_profile_picture_path !== null &&
            (creator.platform_count > 0 || creator.social_link_count > 0) &&
            creator.linked_video_count > 0,
          missing_fields: [
            ...(creator.unified_profile_picture_path ? [] : ["picture"]),
            ...(creator.platform_count > 0 || creator.social_link_count > 0
              ? []
              : ["platform_or_social"]),
            ...(creator.linked_video_count > 0 ? [] : ["linked_videos"]),
          ],
        },
      })
    ) as EnhancedCreator[];
  }

  async getRecent(
    limitParam: number = 10,
    userId?: number
  ): Promise<EnhancedCreator[]> {
    if (env.DEMO_MODE) {
      const { demoRepository } = await import("@/database/demo/repository");
      const listObj = demoRepository.getCreators({ limit: limitParam });
      return listObj.data as EnhancedCreator[];
    }

    const rawQuery = sql`
      SELECT c.*,
        profile_media.file_path as unified_profile_picture_path,
        main_media.file_path as unified_main_picture_path,
        COALESCE(vc.video_count, 0) as linked_video_count,
        COALESCE(pc.platform_count, 0) as platform_count,
        COALESCE(sc.social_link_count, 0) as social_link_count,
        ${this.favoriteSelectSql(userId, sql`c.id`)} as is_favorite
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
        has_profile_picture: creator.unified_profile_picture_path !== null,
        has_main_picture: creator.unified_main_picture_path !== null,
        completeness: {
          is_complete:
            creator.unified_profile_picture_path !== null &&
            (creator.platform_count > 0 || creator.social_link_count > 0) &&
            creator.linked_video_count > 0,
          missing_fields: [
            ...(creator.unified_profile_picture_path ? [] : ["picture"]),
            ...(creator.platform_count > 0 || creator.social_link_count > 0
              ? []
              : ["platform_or_social"]),
            ...(creator.linked_video_count > 0 ? [] : ["linked_videos"]),
          ],
        },
      })
    ) as EnhancedCreator[];
  }

  async quickCreate(
    name: string,
    description?: string,
    userId?: number
  ): Promise<Creator> {
    return this.create(
      { name: name.trim(), description: description?.trim() },
      userId
    );
  }

  private favoriteSelectSql(
    userId: number | undefined,
    creatorIdSql: ReturnType<typeof sql>
  ) {
    if (!userId) {
      return sql`false`;
    }

    return sql`EXISTS (
      SELECT 1
      FROM ${creatorFavoritesTable} cf
      WHERE cf.user_id = ${userId}
        AND cf.creator_id = ${creatorIdSql}
    )`;
  }

  private async getGalleryMedia(creatorId: number) {
    const media = await db
      .select()
      .from(creatorGalleryMediaTable)
      .where(eq(creatorGalleryMediaTable.creatorId, creatorId))
      .orderBy(
        sql`${creatorGalleryMediaTable.createdAt} DESC`,
        sql`${creatorGalleryMediaTable.id} DESC`
      );

    return media.map((item) => ({
      id: item.id,
      creator_id: item.creatorId,
      label: item.label,
      description: item.description,
      file_path: item.filePath,
      is_profile_picture: item.isProfilePicture,
      is_main_picture: item.isMainPicture,
      url: `/api/creators/${creatorId}/gallery/${item.id}/image`,
      created_at:
        item.createdAt instanceof Date
          ? item.createdAt.toISOString()
          : item.createdAt,
      updated_at:
        item.updatedAt instanceof Date
          ? item.updatedAt.toISOString()
          : item.updatedAt,
    }));
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
        creator.unified_profile_picture_path ??
        creator.profilePicturePath ??
        creator.profile_picture_path,
      main_picture_path:
        creator.unified_main_picture_path ??
        creator.mainPicturePath ??
        creator.main_picture_path,
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
      is_favorite: Boolean(creator.is_favorite),
      created_at: toISOString(creator.createdAt ?? creator.created_at),
      updated_at: toISOString(creator.updatedAt ?? creator.updated_at),
      // Rich external metadata (snake_case from `c.*`, camelCase from Drizzle).
      gender: creator.gender ?? null,
      birth_date: creator.birth_date ?? creator.birthDate ?? null,
      death_date: creator.death_date ?? creator.deathDate ?? null,
      ethnicity: creator.ethnicity ?? null,
      country: creator.country ?? null,
      birthplace: creator.birthplace ?? null,
      eye_color: creator.eye_color ?? creator.eyeColor ?? null,
      hair_color: creator.hair_color ?? creator.hairColor ?? null,
      height_cm: creator.height_cm ?? creator.heightCm ?? null,
      cup_size: creator.cup_size ?? creator.cupSize ?? null,
      band_size: creator.band_size ?? creator.bandSize ?? null,
      waist_size: creator.waist_size ?? creator.waistSize ?? null,
      hip_size: creator.hip_size ?? creator.hipSize ?? null,
      breast_type: creator.breast_type ?? creator.breastType ?? null,
      career_start_year:
        creator.career_start_year ?? creator.careerStartYear ?? null,
      career_end_year: creator.career_end_year ?? creator.careerEndYear ?? null,
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
      ...(creator.has_main_picture !== undefined && {
        has_main_picture: creator.has_main_picture,
      }),
      ...(creator.completeness !== undefined && {
        completeness: creator.completeness,
      }),
    };
  }
}

export const creatorsService = new CreatorsService();
