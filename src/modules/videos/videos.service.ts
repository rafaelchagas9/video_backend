import { getDatabase } from "@/config/database";
import { NotFoundError } from "@/utils/errors";
import { API_PREFIX } from "@/config/constants";
import { logger } from "@/utils/logger";
import { readFileSync, existsSync, unlinkSync } from "fs";
import type {
  Video,
  UpdateVideoInput,
  ListVideosOptions,
  NextVideoOptions,
  NextVideoResult,
  TriageQueueOptions,
  TriageQueueResult,
  CompressionSuggestion,
} from "./videos.types";
import { thumbnailsService } from "@/modules/thumbnails/thumbnails.service";
import { conversionService } from "@/modules/conversion/conversion.service";
import { settingsService } from "@/modules/settings/settings.service";

interface PaginatedVideos {
  data: Video[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export class VideosService {
  private get db() {
    return getDatabase();
  }

  private readThumbnailAsBase64(filePath: string | null): string | null {
    if (!filePath || !existsSync(filePath)) {
      return null;
    }
    try {
      const buffer = readFileSync(filePath);
      return `data:image/jpeg;base64,${buffer.toString("base64")}`;
    } catch (error) {
      return null;
    }
  }

  /**
   * Build filter SQL clauses from ListVideosOptions
   * Reusable helper for list(), getNextVideo(), and getTriageQueue()
   */
  private buildFilterQuery(
    userId: number,
    options: ListVideosOptions,
  ): {
    fromClause: string;
    whereClause: string;
    whereParams: any[];
    groupByClause: string;
    havingClause: string;
    needsGroupBy: boolean;
  } {
    const {
      directory_id,
      search,
      include_hidden = false,
      // Resolution filters
      minWidth,
      maxWidth,
      minHeight,
      maxHeight,
      // File size filters
      minFileSize,
      maxFileSize,
      // Duration filters
      minDuration,
      maxDuration,
      // Codec filters
      codec,
      audioCodec,
      // Bitrate filters
      minBitrate,
      maxBitrate,
      // FPS filters
      minFps,
      maxFps,
      // Rating filters
      minRating,
      maxRating,
      // Relationship filters
      creatorIds,
      tagIds,
      studioIds,
      matchMode = "any",
      // Presence flags
      isFavorite,
      hasThumbnail,
      isAvailable,
      // Relationship presence filters
      hasTags,
      hasCreator,
      hasStudio,
      hasRating,
    } = options;

    // Determine required JOINs
    // Determine required JOINs
    const needsRatingJoin = minRating !== undefined || maxRating !== undefined;
    // needsFavoriteJoin is unused as we check isFavorite directly
    const needsCreatorJoin = !!(creatorIds && creatorIds.length > 0);
    const needsTagJoin = !!(tagIds && tagIds.length > 0);
    const needsStudioJoin = !!(studioIds && studioIds.length > 0);

    // For 'all' match mode with arrays, we need GROUP BY + HAVING COUNT
    const needsGroupBy =
      matchMode === "all" &&
      (needsCreatorJoin || needsTagJoin || needsStudioJoin);

    // Build FROM clause with JOINs
    let fromClause = "FROM videos v";

    // Always LEFT JOIN thumbnails for thumbnail_url
    fromClause += "\nLEFT JOIN thumbnails t ON v.id = t.video_id";

    // Rating JOIN - LEFT JOIN with subquery for AVG rating
    if (needsRatingJoin) {
      fromClause +=
        "\nLEFT JOIN (SELECT video_id, AVG(rating) as avg_rating FROM ratings GROUP BY video_id) r ON v.id = r.video_id";
    }

    // Favorite JOIN - INNER if filtering favorites, LEFT for checking
    if (isFavorite === true) {
      fromClause += `\nINNER JOIN favorites f ON v.id = f.video_id AND f.user_id = ${userId}`;
    } else if (isFavorite === false) {
      fromClause += `\nLEFT JOIN favorites f ON v.id = f.video_id AND f.user_id = ${userId}`;
    }

    // Relationship JOINs
    if (needsCreatorJoin) {
      if (matchMode === "any") {
        fromClause += "\nINNER JOIN video_creators vc ON v.id = vc.video_id";
      } else {
        fromClause += "\nLEFT JOIN video_creators vc ON v.id = vc.video_id";
      }
    }

    if (needsTagJoin) {
      if (matchMode === "any") {
        fromClause += "\nINNER JOIN video_tags vt ON v.id = vt.video_id";
      } else {
        fromClause += "\nLEFT JOIN video_tags vt ON v.id = vt.video_id";
      }
    }

    if (needsStudioJoin) {
      if (matchMode === "any") {
        fromClause += "\nINNER JOIN video_studios vs ON v.id = vs.video_id";
      } else {
        fromClause += "\nLEFT JOIN video_studios vs ON v.id = vs.video_id";
      }
    }

    // Build WHERE clause
    const whereClauses: string[] = [];
    const whereParams: any[] = [];

    // Availability filter
    if (isAvailable !== undefined) {
      whereClauses.push("v.is_available = ?");
      whereParams.push(isAvailable ? 1 : 0);
    } else if (!include_hidden) {
      whereClauses.push("v.is_available = 1");
    }

    // Directory filter
    if (directory_id) {
      whereClauses.push("v.directory_id = ?");
      whereParams.push(directory_id);
    }

    // Search filter
    if (search) {
      whereClauses.push(
        "(v.title LIKE ? OR v.description LIKE ? OR v.file_name LIKE ?)",
      );
      const searchPattern = `%${search}%`;
      whereParams.push(searchPattern, searchPattern, searchPattern);
    }

    // Resolution filters
    if (minWidth !== undefined) {
      whereClauses.push("v.width >= ?");
      whereParams.push(minWidth);
    }
    if (maxWidth !== undefined) {
      whereClauses.push("v.width <= ?");
      whereParams.push(maxWidth);
    }
    if (minHeight !== undefined) {
      whereClauses.push("v.height >= ?");
      whereParams.push(minHeight);
    }
    if (maxHeight !== undefined) {
      whereClauses.push("v.height <= ?");
      whereParams.push(maxHeight);
    }

    // File size filters
    if (minFileSize !== undefined) {
      whereClauses.push("v.file_size_bytes >= ?");
      whereParams.push(minFileSize);
    }
    if (maxFileSize !== undefined) {
      whereClauses.push("v.file_size_bytes <= ?");
      whereParams.push(maxFileSize);
    }

    // Duration filters
    if (minDuration !== undefined) {
      whereClauses.push("v.duration_seconds >= ?");
      whereParams.push(minDuration);
    }
    if (maxDuration !== undefined) {
      whereClauses.push("v.duration_seconds <= ?");
      whereParams.push(maxDuration);
    }

    // Codec filters (exact match, case-insensitive)
    if (codec) {
      whereClauses.push("LOWER(v.codec) = LOWER(?)");
      whereParams.push(codec);
    }
    if (audioCodec) {
      whereClauses.push("LOWER(v.audio_codec) = LOWER(?)");
      whereParams.push(audioCodec);
    }

    // Bitrate filters
    if (minBitrate !== undefined) {
      whereClauses.push("v.bitrate >= ?");
      whereParams.push(minBitrate);
    }
    if (maxBitrate !== undefined) {
      whereClauses.push("v.bitrate <= ?");
      whereParams.push(maxBitrate);
    }

    // FPS filters
    if (minFps !== undefined) {
      whereClauses.push("v.fps >= ?");
      whereParams.push(minFps);
    }
    if (maxFps !== undefined) {
      whereClauses.push("v.fps <= ?");
      whereParams.push(maxFps);
    }

    // Rating filters (applied to joined avg_rating)
    if (minRating !== undefined) {
      whereClauses.push("r.avg_rating >= ?");
      whereParams.push(minRating);
    }
    if (maxRating !== undefined) {
      whereClauses.push("r.avg_rating <= ?");
      whereParams.push(maxRating);
    }

    // Thumbnail presence filter
    if (hasThumbnail === true) {
      whereClauses.push("t.id IS NOT NULL");
    } else if (hasThumbnail === false) {
      whereClauses.push("t.id IS NULL");
    }

    // Favorite filter
    if (isFavorite === false) {
      whereClauses.push("f.video_id IS NULL");
    }

    // Relationship presence filters (using EXISTS to avoid row duplication)
    if (hasTags === true) {
      whereClauses.push(
        "EXISTS (SELECT 1 FROM video_tags vt WHERE vt.video_id = v.id)",
      );
    } else if (hasTags === false) {
      whereClauses.push(
        "NOT EXISTS (SELECT 1 FROM video_tags vt WHERE vt.video_id = v.id)",
      );
    }

    if (hasCreator === true) {
      whereClauses.push(
        "EXISTS (SELECT 1 FROM video_creators vc WHERE vc.video_id = v.id)",
      );
    } else if (hasCreator === false) {
      whereClauses.push(
        "NOT EXISTS (SELECT 1 FROM video_creators vc WHERE vc.video_id = v.id)",
      );
    }

    if (hasStudio === true) {
      whereClauses.push(
        "EXISTS (SELECT 1 FROM video_studios vs WHERE vs.video_id = v.id)",
      );
    } else if (hasStudio === false) {
      whereClauses.push(
        "NOT EXISTS (SELECT 1 FROM video_studios vs WHERE vs.video_id = v.id)",
      );
    }

    if (hasRating === true) {
      whereClauses.push(
        "EXISTS (SELECT 1 FROM ratings r WHERE r.video_id = v.id)",
      );
    } else if (hasRating === false) {
      whereClauses.push(
        "NOT EXISTS (SELECT 1 FROM ratings r WHERE r.video_id = v.id)",
      );
    }

    // Relationship filters - array-based
    if (needsCreatorJoin && creatorIds!.length > 0) {
      if (matchMode === "any") {
        whereClauses.push(
          `vc.creator_id IN (${creatorIds!.map(() => "?").join(",")})`,
        );
        whereParams.push(...creatorIds!);
      } else {
        whereClauses.push(
          `vc.creator_id IN (${creatorIds!.map(() => "?").join(",")}) OR vc.creator_id IS NULL`,
        );
        whereParams.push(...creatorIds!);
      }
    }

    if (needsTagJoin && tagIds!.length > 0) {
      if (matchMode === "any") {
        whereClauses.push(`vt.tag_id IN (${tagIds!.map(() => "?").join(",")})`);
        whereParams.push(...tagIds!);
      } else {
        whereClauses.push(
          `vt.tag_id IN (${tagIds!.map(() => "?").join(",")}) OR vt.tag_id IS NULL`,
        );
        whereParams.push(...tagIds!);
      }
    }

    if (needsStudioJoin && studioIds!.length > 0) {
      if (matchMode === "any") {
        whereClauses.push(
          `vs.studio_id IN (${studioIds!.map(() => "?").join(",")})`,
        );
        whereParams.push(...studioIds!);
      } else {
        whereClauses.push(
          `vs.studio_id IN (${studioIds!.map(() => "?").join(",")}) OR vs.studio_id IS NULL`,
        );
        whereParams.push(...studioIds!);
      }
    }

    const whereClause =
      whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

    // GROUP BY clause (needed when using array filters with 'all' mode)
    let groupByClause = "";
    let havingClause = "";

    if (needsGroupBy) {
      groupByClause = "GROUP BY v.id";

      const havingConditions: string[] = [];

      if (needsCreatorJoin && creatorIds!.length > 0) {
        havingConditions.push(
          `COUNT(DISTINCT vc.creator_id) >= ${creatorIds!.length}`,
        );
      }

      if (needsTagJoin && tagIds!.length > 0) {
        havingConditions.push(`COUNT(DISTINCT vt.tag_id) >= ${tagIds!.length}`);
      }

      if (needsStudioJoin && studioIds!.length > 0) {
        havingConditions.push(
          `COUNT(DISTINCT vs.studio_id) >= ${studioIds!.length}`,
        );
      }

      if (havingConditions.length > 0) {
        havingClause = `HAVING ${havingConditions.join(" AND ")}`;
      }
    }

    return {
      fromClause,
      whereClause,
      whereParams,
      groupByClause,
      havingClause,
      needsGroupBy,
    };
  }

  async list(
    userId: number,
    options: ListVideosOptions = {},
  ): Promise<PaginatedVideos> {
    const {
      page = 1,
      limit = 20,
      sort = "created_at",
      order = "desc",
    } = options;

    const offset = (page - 1) * limit;

    // Build filter SQL using helper
    const {
      fromClause,
      whereClause,
      whereParams,
      groupByClause,
      havingClause,
      needsGroupBy,
    } = this.buildFilterQuery(userId, options);

    // Get total count (need separate query without pagination)
    const countQuery = `
      SELECT COUNT(${needsGroupBy ? "DISTINCT v.id" : "*"}) as count
      ${fromClause}
      ${whereClause}
      ${needsGroupBy && !havingClause ? groupByClause : ""}
      ${havingClause}
    `;

    const countResult = this.db.prepare(countQuery).get(...whereParams) as {
      count: number;
    };
    const total = countResult.count;
    const totalPages = Math.ceil(total / limit);

    // Get videos with sorting and pagination
    const validSortColumns = [
      "created_at",
      "file_name",
      "duration_seconds",
      "file_size_bytes",
      "indexed_at",
      "width",
      "height",
      "bitrate",
      "fps",
    ];
    const sortColumn = validSortColumns.includes(sort) ? sort : "created_at";
    const sortOrder = order === "asc" ? "ASC" : "DESC";

    const selectQuery = `
      SELECT ${needsGroupBy ? "DISTINCT" : ""} v.*, t.id as thumbnail_id, t.file_path as thumbnail_file_path
      ${fromClause}
      ${whereClause}
      ${groupByClause}
      ${havingClause}
      ORDER BY v.${sortColumn} ${sortOrder}
      LIMIT ? OFFSET ?
    `;

    const videos = this.db
      .prepare(selectQuery)
      .all(...whereParams, limit, offset) as (Video & {
      thumbnail_file_path: string | null;
    })[];

    return {
      data: videos.map((v) => ({
        ...v,
        thumbnail_url: v.thumbnail_id
          ? `${API_PREFIX}/thumbnails/${v.thumbnail_id}/image`
          : null,
        thumbnail_base64: this.readThumbnailAsBase64(v.thumbnail_file_path),
        is_favorite: this.db
          .prepare("SELECT 1 FROM favorites WHERE user_id = ? AND video_id = ?")
          .get(userId, v.id)
          ? true
          : false,
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages,
      },
    };
  }

  async getNextVideo(
    userId: number,
    options: NextVideoOptions,
  ): Promise<NextVideoResult> {
    const {
      currentId,
      direction = "next",
      sort = "created_at",
      order = "desc",
    } = options;

    // Build filter SQL using helper
    const {
      fromClause,
      whereClause,
      whereParams,
      groupByClause,
      havingClause,
      needsGroupBy,
    } = this.buildFilterQuery(userId, options);

    // Get current video to extract sort value
    const currentVideo = await this.findById(currentId, userId);

    // Validate sort column
    const validSortColumns = [
      "created_at",
      "file_name",
      "duration_seconds",
      "file_size_bytes",
      "indexed_at",
      "width",
      "height",
      "bitrate",
      "fps",
    ];
    const sortColumn = validSortColumns.includes(sort) ? sort : "created_at";
    const currentSortValue = (currentVideo as any)[sortColumn];

    // Determine comparison operators based on direction and order
    // For 'next' with 'desc': find videos with sortValue < current (going backward in value)
    // For 'next' with 'asc': find videos with sortValue > current (going forward in value)
    // For 'previous': opposite of next
    const isDescending = order === "desc";
    const isNext = direction === "next";

    // Determine the comparison operator for finding next/previous
    let comparisonOp: string;
    let tiebreakOp: string;
    let sortDirection: string;

    if (isNext) {
      if (isDescending) {
        comparisonOp = "<"; // Next in descending order means smaller values
        tiebreakOp = "<";
        sortDirection = "DESC";
      } else {
        comparisonOp = ">"; // Next in ascending order means larger values
        tiebreakOp = ">";
        sortDirection = "ASC";
      }
    } else {
      // Previous is opposite of next
      if (isDescending) {
        comparisonOp = ">"; // Previous in descending order means larger values
        tiebreakOp = ">";
        sortDirection = "ASC";
      } else {
        comparisonOp = "<"; // Previous in ascending order means smaller values
        tiebreakOp = "<";
        sortDirection = "DESC";
      }
    }

    // Build positional WHERE clause
    const positionalWhere = whereClause
      ? `${whereClause} AND (v.${sortColumn} ${comparisonOp} ? OR (v.${sortColumn} = ? AND v.id ${tiebreakOp} ?))`
      : `WHERE (v.${sortColumn} ${comparisonOp} ? OR (v.${sortColumn} = ? AND v.id ${tiebreakOp} ?))`;

    const positionalParams = [
      ...whereParams,
      currentSortValue,
      currentSortValue,
      currentId,
    ];

    // Try to find next/previous video
    const nextVideoQuery = `
      SELECT ${needsGroupBy ? "DISTINCT" : ""} v.*, t.id as thumbnail_id, t.file_path as thumbnail_file_path
      ${fromClause}
      ${positionalWhere}
      ${groupByClause}
      ${havingClause}
      ORDER BY v.${sortColumn} ${sortDirection}, v.id ${sortDirection}
      LIMIT 1
    `;

    let nextVideo = this.db.prepare(nextVideoQuery).get(...positionalParams) as
      | (Video & { thumbnail_file_path: string | null })
      | undefined;
    let hasWrapped = false;

    // If no video found, wrap around
    if (!nextVideo) {
      hasWrapped = true;
      const wrapSortDirection = isNext
        ? isDescending
          ? "DESC"
          : "ASC"
        : isDescending
          ? "ASC"
          : "DESC";
      const wrapQuery = `
        SELECT ${needsGroupBy ? "DISTINCT" : ""} v.*, t.id as thumbnail_id, t.file_path as thumbnail_file_path
        ${fromClause}
        ${whereClause}
        ${groupByClause}
        ${havingClause}
        ORDER BY v.${sortColumn} ${wrapSortDirection}, v.id ${wrapSortDirection}
        LIMIT 1
      `;
      nextVideo = this.db.prepare(wrapQuery).get(...whereParams) as
        | (Video & { thumbnail_file_path: string | null })
        | undefined;
    }

    // Get total matching count
    const totalQuery = `
      SELECT COUNT(${needsGroupBy ? "DISTINCT v.id" : "*"}) as count
      ${fromClause}
      ${whereClause}
      ${havingClause}
    `;
    const totalResult = this.db.prepare(totalQuery).get(...whereParams) as {
      count: number;
    };

    // Get remaining count (videos in the direction of travel)
    const remainingQuery = `
      SELECT COUNT(${needsGroupBy ? "DISTINCT v.id" : "*"}) as count
      ${fromClause}
      ${positionalWhere}
      ${havingClause}
    `;
    const remainingResult = this.db
      .prepare(remainingQuery)
      .get(...positionalParams) as { count: number };

    // Prepare video response
    let videoResponse: Video | null = null;
    if (nextVideo) {
      const isFavorite = this.db
        .prepare("SELECT 1 FROM favorites WHERE user_id = ? AND video_id = ?")
        .get(userId, nextVideo.id)
        ? true
        : false;
      videoResponse = {
        ...nextVideo,
        thumbnail_url: nextVideo.thumbnail_id
          ? `${API_PREFIX}/thumbnails/${nextVideo.thumbnail_id}/image`
          : null,
        thumbnail_base64: this.readThumbnailAsBase64(
          nextVideo.thumbnail_file_path,
        ),
        is_favorite: isFavorite,
      } as Video;
    }

    return {
      video: videoResponse,
      meta: {
        remaining: hasWrapped ? totalResult.count - 1 : remainingResult.count,
        total_matching: totalResult.count,
        has_wrapped: hasWrapped,
      },
    };
  }

  async getTriageQueue(
    userId: number,
    options: TriageQueueOptions,
  ): Promise<TriageQueueResult> {
    const {
      queueLimit = 100,
      queueOffset = 0,
      sort = "created_at",
      order = "desc",
    } = options;

    // Build filter SQL using helper
    const {
      fromClause,
      whereClause,
      whereParams,
      groupByClause,
      havingClause,
      needsGroupBy,
    } = this.buildFilterQuery(userId, options);

    // Validate sort column
    const validSortColumns = [
      "created_at",
      "file_name",
      "duration_seconds",
      "file_size_bytes",
      "indexed_at",
      "width",
      "height",
      "bitrate",
      "fps",
    ];
    const sortColumn = validSortColumns.includes(sort) ? sort : "created_at";
    const sortOrder = order === "asc" ? "ASC" : "DESC";

    // Get total count
    const countQuery = `
      SELECT COUNT(${needsGroupBy ? "DISTINCT v.id" : "*"}) as count
      ${fromClause}
      ${whereClause}
      ${havingClause}
    `;
    const countResult = this.db.prepare(countQuery).get(...whereParams) as {
      count: number;
    };

    // Get ordered IDs only (no JOINs for thumbnails, etc. - only v.id)
    const idsQuery = `
      SELECT ${needsGroupBy ? "DISTINCT" : ""} v.id
      ${fromClause}
      ${whereClause}
      ${groupByClause}
      ${havingClause}
      ORDER BY v.${sortColumn} ${sortOrder}, v.id ${sortOrder}
      LIMIT ? OFFSET ?
    `;

    const ids = this.db
      .prepare(idsQuery)
      .all(...whereParams, queueLimit, queueOffset) as { id: number }[];

    return {
      ids: ids.map((row) => row.id),
      total: countResult.count,
    };
  }

  async getCompressionSuggestions(
    options: { limit?: number; offset?: number } = {},
  ): Promise<CompressionSuggestion[]> {
    const maxSuggestions = await settingsService.getNumber("max_suggestions");
    const downscaleInactiveDays = await settingsService.getNumber(
      "downscale_inactive_days",
    );
    const minWatchSeconds =
      await settingsService.getNumber("min_watch_seconds");

    const limit = Math.min(options.limit ?? 50, maxSuggestions || 200);
    const offset = options.offset ?? 0;
    const queryLimit = Math.min(limit * 3, maxSuggestions || 200);

    const rows = this.db
      .prepare(
        `SELECT v.id as video_id,
                v.file_name,
                v.file_size_bytes,
                v.width,
                v.height,
                v.codec,
                v.bitrate,
                v.fps,
                v.duration_seconds,
                COALESCE(stats.total_play_count, 0) as total_play_count,
                COALESCE(stats.total_watch_seconds, 0) as total_watch_seconds,
                stats.last_played_at
         FROM videos v
         LEFT JOIN (
           SELECT video_id,
                  SUM(play_count) as total_play_count,
                  SUM(total_watch_seconds) as total_watch_seconds,
                  MAX(last_played_at) as last_played_at
           FROM video_stats
           GROUP BY video_id
         ) stats ON v.id = stats.video_id
         WHERE v.is_available = 1
         ORDER BY v.file_size_bytes DESC
         LIMIT ? OFFSET ?`,
      )
      .all(queryLimit, offset) as Array<{
      video_id: number;
      file_name: string;
      file_size_bytes: number;
      width: number | null;
      height: number | null;
      codec: string | null;
      bitrate: number | null;
      fps: number | null;
      duration_seconds: number | null;
      total_play_count: number;
      total_watch_seconds: number;
      last_played_at: string | null;
    }>;

    const now = new Date();

    const suggestions = rows
      .map((row) => {
        const reasons = new Set<string>();
        let technicalScore = 0;
        let usageScore = 0;

        const codec = row.codec?.toLowerCase() ?? "";
        const codecCategory = codec.includes("av1")
          ? "av1"
          : codec.includes("hevc") || codec.includes("h265")
            ? "hevc"
            : codec.includes("h264") || codec.includes("avc")
              ? "h264"
              : "other";

        if (codecCategory !== "av1") {
          reasons.add("codec-inefficient");
          technicalScore +=
            codecCategory === "h264" ? 40 : codecCategory === "hevc" ? 20 : 30;
        }

        const fileSizeGb = row.file_size_bytes / 1024 ** 3;
        if (fileSizeGb >= 20) {
          reasons.add("large-file");
          technicalScore += 30;
        } else if (fileSizeGb >= 10) {
          reasons.add("large-file");
          technicalScore += 20;
        } else if (fileSizeGb >= 5) {
          reasons.add("large-file");
          technicalScore += 12;
        }

        const bitrateKbps = row.bitrate ? row.bitrate / 1000 : null;
        if (bitrateKbps !== null) {
          if (bitrateKbps >= 20000) {
            reasons.add("high-bitrate");
            technicalScore += 15;
          } else if (bitrateKbps >= 12000) {
            reasons.add("high-bitrate");
            technicalScore += 8;
          }
        }

        if ((row.height ?? 0) >= 2160) {
          reasons.add("ultra-hd");
          technicalScore += 20;
        } else if ((row.height ?? 0) >= 1440) {
          reasons.add("high-resolution");
          technicalScore += 10;
        }

        if ((row.fps ?? 0) >= 60) {
          reasons.add("high-fps");
          technicalScore += 6;
        }

        if (row.total_play_count <= 1) {
          reasons.add("low-play-count");
          usageScore += 15;
        } else if (row.total_play_count <= 3) {
          reasons.add("low-play-count");
          usageScore += 8;
        }

        if (row.total_watch_seconds < minWatchSeconds) {
          reasons.add("low-watch-time");
          usageScore += 8;
        }

        let daysSinceLastPlayed: number | null = null;
        if (row.last_played_at) {
          const lastPlayedAt = new Date(row.last_played_at);
          if (!Number.isNaN(lastPlayedAt.getTime())) {
            daysSinceLastPlayed =
              (now.getTime() - lastPlayedAt.getTime()) / (1000 * 60 * 60 * 24);
          }
        }

        if (daysSinceLastPlayed === null) {
          reasons.add("never-played");
          usageScore += 20;
        } else if (daysSinceLastPlayed >= downscaleInactiveDays) {
          reasons.add("stale-playback");
          usageScore += 12;
        }

        const recommendedActions: string[] = [];
        if (codecCategory !== "av1") {
          recommendedActions.push("reencode_av1");
        }

        const shouldDownscale =
          (row.height ?? 0) >= 2160 &&
          (daysSinceLastPlayed === null ||
            daysSinceLastPlayed >= downscaleInactiveDays);

        if (shouldDownscale) {
          recommendedActions.push("downscale_1080p");
        }

        return {
          video_id: row.video_id,
          file_name: row.file_name,
          file_size_bytes: row.file_size_bytes,
          width: row.width,
          height: row.height,
          codec: row.codec,
          bitrate: row.bitrate,
          fps: row.fps,
          duration_seconds: row.duration_seconds,
          total_play_count: row.total_play_count,
          total_watch_seconds: row.total_watch_seconds,
          last_played_at: row.last_played_at,
          technical_score: technicalScore,
          usage_score: usageScore,
          recommended_actions: recommendedActions,
          reasons: Array.from(reasons),
        } as CompressionSuggestion;
      })
      .filter((suggestion) => suggestion.recommended_actions.length > 0)
      .sort((a, b) => {
        if (b.technical_score !== a.technical_score) {
          return b.technical_score - a.technical_score;
        }
        if (b.usage_score !== a.usage_score) {
          return b.usage_score - a.usage_score;
        }
        return b.file_size_bytes - a.file_size_bytes;
      })
      .slice(0, limit);

    return suggestions;
  }

  async findById(
    id: number,
    userId?: number,
  ): Promise<
    Video & { thumbnail_url?: string | null; thumbnail_base64?: string | null }
  > {
    const video = this.db
      .prepare(
        `
        SELECT v.*, t.id as thumbnail_id, t.file_path as thumbnail_file_path
        FROM videos v
        LEFT JOIN thumbnails t ON v.id = t.video_id
        WHERE v.id = ?
      `,
      )
      .get(id) as (Video & { thumbnail_file_path: string | null }) | undefined;

    if (!video) {
      throw new NotFoundError(`Video not found with id: ${id}`);
    }

    let isFavorite = false;
    if (userId) {
      isFavorite = this.db
        .prepare("SELECT 1 FROM favorites WHERE user_id = ? AND video_id = ?")
        .get(userId, id)
        ? true
        : false;
    }

    video.is_favorite = isFavorite;

    return {
      ...video,
      thumbnail_url: video.thumbnail_id
        ? `${API_PREFIX}/thumbnails/${video.thumbnail_id}/image`
        : null,
      thumbnail_base64: this.readThumbnailAsBase64(video.thumbnail_file_path),
    };
  }

  async getRandomVideo(
    userId: number,
  ): Promise<
    Video & { thumbnail_url?: string | null; thumbnail_base64?: string | null }
  > {
    const randomVideo = this.db
      .prepare(
        `
        SELECT id FROM videos
        WHERE is_available = 1
        ORDER BY RANDOM()
        LIMIT 1
      `,
      )
      .get() as { id: number } | undefined;

    if (!randomVideo) {
      throw new NotFoundError("No available videos found");
    }

    return this.findById(randomVideo.id, userId);
  }

  async update(id: number, input: UpdateVideoInput): Promise<Video> {
    await this.findById(id); // Ensure exists

    const updates: string[] = [];
    const values: any[] = [];

    if (input.title !== undefined) {
      updates.push("title = ?");
      values.push(input.title);
    }

    if (input.description !== undefined) {
      updates.push("description = ?");
      values.push(input.description);
    }

    if (input.themes !== undefined) {
      updates.push("themes = ?");
      values.push(input.themes);
    }

    if (updates.length === 0) {
      return this.findById(id);
    }

    updates.push("updated_at = datetime('now')");
    values.push(id);

    this.db
      .prepare(
        `UPDATE videos
         SET ${updates.join(", ")}
         WHERE id = ?`,
      )
      .run(...values);

    return this.findById(id);
  }

  async delete(id: number): Promise<void> {
    const video = await this.findById(id); // Ensure exists

    // Delete all thumbnails (both file and DB)
    const thumbnails = await thumbnailsService.getByVideoId(id);
    for (const thumbnail of thumbnails) {
      try {
        await thumbnailsService.delete(thumbnail.id);
      } catch (error) {
        logger.warn(
          { error, thumbnailId: thumbnail.id },
          "Failed to delete thumbnail",
        );
      }
    }

    // Delete conversion DB records (keep converted files - they're valuable outputs)
    const conversions = await conversionService.listByVideoId(id);
    for (const conversion of conversions) {
      try {
        this.db
          .prepare("DELETE FROM conversion_jobs WHERE id = ?")
          .run(conversion.id);
      } catch (error) {
        logger.warn(
          { error, conversionId: conversion.id },
          "Failed to delete conversion record",
        );
      }
    }

    // Delete the video file itself
    if (video.file_path) {
      try {
        if (existsSync(video.file_path)) {
          unlinkSync(video.file_path);
        }
      } catch (error) {
        logger.warn(
          { error, path: video.file_path },
          "Failed to delete video file",
        );
        // Continue with database deletion even if file deletion fails
      }
    }

    // Delete the video database record
    this.db.prepare("DELETE FROM videos WHERE id = ?").run(id);
  }

  async verifyAvailability(id: number): Promise<Video> {
    const video = await this.findById(id);

    const fs = await import("fs");
    const exists = fs.existsSync(video.file_path);

    this.db
      .prepare(
        "UPDATE videos SET is_available = ?, last_verified_at = datetime('now') WHERE id = ?",
      )
      .run(exists ? 1 : 0, id);

    return this.findById(id);
  }

  // ========== CUSTOM METADATA ==========

  async getMetadata(
    videoId: number,
  ): Promise<{ key: string; value: string }[]> {
    await this.findById(videoId); // Ensure video exists

    return this.db
      .prepare(
        "SELECT key, value FROM video_metadata WHERE video_id = ? ORDER BY key ASC",
      )
      .all(videoId) as { key: string; value: string }[];
  }

  async setMetadata(
    videoId: number,
    key: string,
    value: string,
  ): Promise<void> {
    await this.findById(videoId); // Ensure video exists

    // Upsert: insert or update
    this.db
      .prepare(
        `INSERT INTO video_metadata (video_id, key, value)
         VALUES (?, ?, ?)
         ON CONFLICT(video_id, key) DO UPDATE SET
           value = excluded.value,
           updated_at = datetime('now')`,
      )
      .run(videoId, key, value);
  }

  async deleteMetadata(videoId: number, key: string): Promise<void> {
    await this.findById(videoId); // Ensure video exists

    const result = this.db
      .prepare("DELETE FROM video_metadata WHERE video_id = ? AND key = ?")
      .run(videoId, key);

    if (result.changes === 0) {
      throw new NotFoundError(`Metadata key "${key}" not found`);
    }
  }

  // Studio relationship methods
  async getStudios(videoId: number) {
    await this.findById(videoId); // Ensure video exists

    const studios = this.db
      .prepare(
        `SELECT s.* FROM studios s
         INNER JOIN video_studios vs ON s.id = vs.studio_id
         WHERE vs.video_id = ?
         ORDER BY s.name ASC`,
      )
      .all(videoId);

    return studios;
  }

  // Bulk Actions
  async bulkDelete(ids: number[]): Promise<void> {
    if (ids.length === 0) return;

    // Delete each video individually to ensure file cleanup
    for (const id of ids) {
      try {
        await this.delete(id);
      } catch (error) {
        logger.warn(
          { error, videoId: id },
          "Failed to delete video in bulk operation",
        );
        // Continue with remaining videos even if one fails
      }
    }
  }

  async bulkUpdateCreators(input: {
    videoIds: number[];
    creatorIds: number[];
    action: "add" | "remove";
  }): Promise<void> {
    const { videoIds, creatorIds, action } = input;
    if (videoIds.length === 0 || creatorIds.length === 0) return;

    const update = this.db.transaction(() => {
      if (action === "add") {
        const insert = this.db.prepare(
          "INSERT OR IGNORE INTO video_creators (video_id, creator_id) VALUES (?, ?)",
        );
        for (const videoId of videoIds) {
          for (const creatorId of creatorIds) {
            insert.run(videoId, creatorId);
          }
        }
      } else {
        const deleteStmt = this.db.prepare(
          `DELETE FROM video_creators WHERE video_id = ? AND creator_id IN (${creatorIds.map(() => "?").join(",")})`,
        );
        for (const videoId of videoIds) {
          deleteStmt.run(videoId, ...creatorIds);
        }
      }
    });

    update();
  }

  async bulkUpdateTags(input: {
    videoIds: number[];
    tagIds: number[];
    action: "add" | "remove";
  }): Promise<void> {
    const { videoIds, tagIds, action } = input;
    if (videoIds.length === 0 || tagIds.length === 0) return;

    const update = this.db.transaction(() => {
      if (action === "add") {
        const insert = this.db.prepare(
          "INSERT OR IGNORE INTO video_tags (video_id, tag_id) VALUES (?, ?)",
        );
        for (const videoId of videoIds) {
          for (const tagId of tagIds) {
            insert.run(videoId, tagId);
          }
        }
      } else {
        const deleteStmt = this.db.prepare(
          `DELETE FROM video_tags WHERE video_id = ? AND tag_id IN (${tagIds.map(() => "?").join(",")})`,
        );
        for (const videoId of videoIds) {
          deleteStmt.run(videoId, ...tagIds);
        }
      }
    });

    update();
  }

  async bulkUpdateStudios(input: {
    videoIds: number[];
    studioIds: number[];
    action: "add" | "remove";
  }): Promise<void> {
    const { videoIds, studioIds, action } = input;
    if (videoIds.length === 0 || studioIds.length === 0) return;

    const update = this.db.transaction(() => {
      if (action === "add") {
        const insert = this.db.prepare(
          "INSERT OR IGNORE INTO video_studios (video_id, studio_id) VALUES (?, ?)",
        );
        for (const videoId of videoIds) {
          for (const studioId of studioIds) {
            insert.run(videoId, studioId);
          }
        }
      } else {
        const deleteStmt = this.db.prepare(
          `DELETE FROM video_studios WHERE video_id = ? AND studio_id IN (${studioIds.map(() => "?").join(",")})`,
        );
        for (const videoId of videoIds) {
          deleteStmt.run(videoId, ...studioIds);
        }
      }
    });

    update();
  }

  async bulkUpdateFavorites(
    userId: number,
    input: { videoIds: number[]; isFavorite: boolean },
  ): Promise<void> {
    const { videoIds, isFavorite } = input;
    if (videoIds.length === 0) return;

    const update = this.db.transaction(() => {
      if (isFavorite) {
        const insert = this.db.prepare(
          "INSERT OR IGNORE INTO favorites (user_id, video_id) VALUES (?, ?)",
        );
        for (const videoId of videoIds) {
          insert.run(userId, videoId);
        }
      } else {
        const placeholders = videoIds.map(() => "?").join(",");
        this.db
          .prepare(
            `DELETE FROM favorites WHERE user_id = ? AND video_id IN (${placeholders})`,
          )
          .run(userId, ...videoIds);
      }
    });

    update();
  }

  async getDuplicates(): Promise<
    {
      file_hash: string;
      count: number;
      total_size_bytes: number;
      videos: Array<{
        id: number;
        file_name: string;
        file_path: string;
        file_size_bytes: number;
        indexed_at: string;
      }>;
    }[]
  > {
    // Find all file_hash values that appear more than once
    const duplicateHashes = this.db
      .prepare(
        `SELECT file_hash, COUNT(*) as count, SUM(file_size_bytes) as total_size_bytes
         FROM videos
         WHERE file_hash IS NOT NULL AND file_hash != ''
         GROUP BY file_hash
         HAVING COUNT(*) > 1
         ORDER BY total_size_bytes DESC`,
      )
      .all() as Array<{
      file_hash: string;
      count: number;
      total_size_bytes: number;
    }>;

    // For each duplicate hash, get the video details
    const result = duplicateHashes.map((dup) => {
      const videos = this.db
        .prepare(
          `SELECT id, file_name, file_path, file_size_bytes, indexed_at
           FROM videos
           WHERE file_hash = ?
           ORDER BY indexed_at ASC`,
        )
        .all(dup.file_hash) as Array<{
        id: number;
        file_name: string;
        file_path: string;
        file_size_bytes: number;
        indexed_at: string;
      }>;

      return {
        file_hash: dup.file_hash,
        count: dup.count,
        total_size_bytes: dup.total_size_bytes,
        videos,
      };
    });

    return result;
  }
}

export const videosService = new VideosService();
