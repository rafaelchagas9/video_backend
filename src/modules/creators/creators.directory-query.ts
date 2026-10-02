import { creatorVideoCountsSql } from "./creators.video-counts";
import { sql, type SQL } from "drizzle-orm";
import type { ListCreatorsOptions } from "./creators.types";

/** Shared existing directory constraints. Attribute facets retain all of these. */
export function creatorDirectoryQuery(
  options: ListCreatorsOptions,
  userId?: number
) {
  const {
    search,
    minVideoCount,
    maxVideoCount,
    hasProfilePicture,
    isFavorite,
    studioIds,
    missing,
    complete,
  } = options;
  // Build WHERE conditions as SQL fragments
  const whereConditions: SQL[] = [];

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
  } else if (isFavorite === false && userId) {
    whereConditions.push(
      sql`NOT EXISTS (SELECT 1 FROM creator_favorites cf_only WHERE cf_only.user_id = ${userId} AND cf_only.creator_id = c.id)`
    );
  }

  // Video count filters
  if (minVideoCount !== undefined) {
    whereConditions.push(sql`COALESCE(vc.video_count, 0) >= ${minVideoCount}`);
  }
  if (maxVideoCount !== undefined) {
    whereConditions.push(sql`COALESCE(vc.video_count, 0) <= ${maxVideoCount}`);
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
        ${creatorVideoCountsSql()}
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

  return { baseFrom, studioJoin, platformSearchJoin, whereClause };
}
