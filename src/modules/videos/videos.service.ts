import { getDatabase } from '@/config/database';
import { NotFoundError } from '@/utils/errors';
import { API_PREFIX } from '@/config/constants';
import { readFileSync, existsSync } from 'fs';
import type { Video, UpdateVideoInput, ListVideosOptions } from './videos.types';

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
      return `data:image/jpeg;base64,${buffer.toString('base64')}`;
    } catch (error) {
      return null;
    }
  }

  async list(userId: number, options: ListVideosOptions = {}): Promise<PaginatedVideos> {
    const {
      page = 1,
      limit = 20,
      directory_id,
      search,
      sort = 'created_at',
      order = 'desc',
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
      matchMode = 'any',
      // Presence flags
      isFavorite,
      hasThumbnail,
      isAvailable,
    } = options;

    const offset = (page - 1) * limit;

    // Determine required JOINs
    const needsRatingJoin = minRating !== undefined || maxRating !== undefined;
    const needsFavoriteJoin = isFavorite !== undefined;
    const needsCreatorJoin = creatorIds && creatorIds.length > 0;
    const needsTagJoin = tagIds && tagIds.length > 0;
    const needsStudioJoin = studioIds && studioIds.length > 0;

    // For 'all' match mode with arrays, we need GROUP BY + HAVING COUNT
    const needsGroupBy = matchMode === 'all' && (needsCreatorJoin || needsTagJoin || needsStudioJoin);

    // Build FROM clause with JOINs
    let fromClause = 'FROM videos v';

    // Always LEFT JOIN thumbnails for thumbnail_url
    fromClause += '\nLEFT JOIN thumbnails t ON v.id = t.video_id';

    // Rating JOIN - LEFT JOIN with subquery for AVG rating
    if (needsRatingJoin) {
      fromClause += '\nLEFT JOIN (SELECT video_id, AVG(rating) as avg_rating FROM ratings GROUP BY video_id) r ON v.id = r.video_id';
    }

    // Favorite JOIN - INNER if filtering favorites, LEFT for checking
    if (isFavorite === true) {
      fromClause += `\nINNER JOIN favorites f ON v.id = f.video_id AND f.user_id = ${userId}`;
    } else if (isFavorite === false) {
      fromClause += `\nLEFT JOIN favorites f ON v.id = f.video_id AND f.user_id = ${userId}`;
    }

    // Relationship JOINs
    if (needsCreatorJoin) {
      if (matchMode === 'any') {
        fromClause += '\nINNER JOIN video_creators vc ON v.id = vc.video_id';
      } else {
        fromClause += '\nLEFT JOIN video_creators vc ON v.id = vc.video_id';
      }
    }

    if (needsTagJoin) {
      if (matchMode === 'any') {
        fromClause += '\nINNER JOIN video_tags vt ON v.id = vt.video_id';
      } else {
        fromClause += '\nLEFT JOIN video_tags vt ON v.id = vt.video_id';
      }
    }

    if (needsStudioJoin) {
      if (matchMode === 'any') {
        fromClause += '\nINNER JOIN video_studios vs ON v.id = vs.video_id';
      } else {
        fromClause += '\nLEFT JOIN video_studios vs ON v.id = vs.video_id';
      }
    }

    // Build WHERE clause
    const whereClauses: string[] = [];
    const whereParams: any[] = [];

    // Availability filter
    if (isAvailable !== undefined) {
      whereClauses.push('v.is_available = ?');
      whereParams.push(isAvailable ? 1 : 0);
    } else if (!include_hidden) {
      whereClauses.push('v.is_available = 1');
    }

    // Directory filter
    if (directory_id) {
      whereClauses.push('v.directory_id = ?');
      whereParams.push(directory_id);
    }

    // Search filter
    if (search) {
      whereClauses.push(
        '(v.title LIKE ? OR v.description LIKE ? OR v.file_name LIKE ?)'
      );
      const searchPattern = `%${search}%`;
      whereParams.push(searchPattern, searchPattern, searchPattern);
    }

    // Resolution filters
    if (minWidth !== undefined) {
      whereClauses.push('v.width >= ?');
      whereParams.push(minWidth);
    }
    if (maxWidth !== undefined) {
      whereClauses.push('v.width <= ?');
      whereParams.push(maxWidth);
    }
    if (minHeight !== undefined) {
      whereClauses.push('v.height >= ?');
      whereParams.push(minHeight);
    }
    if (maxHeight !== undefined) {
      whereClauses.push('v.height <= ?');
      whereParams.push(maxHeight);
    }

    // File size filters
    if (minFileSize !== undefined) {
      whereClauses.push('v.file_size_bytes >= ?');
      whereParams.push(minFileSize);
    }
    if (maxFileSize !== undefined) {
      whereClauses.push('v.file_size_bytes <= ?');
      whereParams.push(maxFileSize);
    }

    // Duration filters
    if (minDuration !== undefined) {
      whereClauses.push('v.duration_seconds >= ?');
      whereParams.push(minDuration);
    }
    if (maxDuration !== undefined) {
      whereClauses.push('v.duration_seconds <= ?');
      whereParams.push(maxDuration);
    }

    // Codec filters (exact match, case-insensitive)
    if (codec) {
      whereClauses.push('LOWER(v.codec) = LOWER(?)');
      whereParams.push(codec);
    }
    if (audioCodec) {
      whereClauses.push('LOWER(v.audio_codec) = LOWER(?)');
      whereParams.push(audioCodec);
    }

    // Bitrate filters
    if (minBitrate !== undefined) {
      whereClauses.push('v.bitrate >= ?');
      whereParams.push(minBitrate);
    }
    if (maxBitrate !== undefined) {
      whereClauses.push('v.bitrate <= ?');
      whereParams.push(maxBitrate);
    }

    // FPS filters
    if (minFps !== undefined) {
      whereClauses.push('v.fps >= ?');
      whereParams.push(minFps);
    }
    if (maxFps !== undefined) {
      whereClauses.push('v.fps <= ?');
      whereParams.push(maxFps);
    }

    // Rating filters (applied to joined avg_rating)
    if (minRating !== undefined) {
      whereClauses.push('r.avg_rating >= ?');
      whereParams.push(minRating);
    }
    if (maxRating !== undefined) {
      whereClauses.push('r.avg_rating <= ?');
      whereParams.push(maxRating);
    }

    // Thumbnail presence filter
    if (hasThumbnail === true) {
      whereClauses.push('t.id IS NOT NULL');
    } else if (hasThumbnail === false) {
      whereClauses.push('t.id IS NULL');
    }

    // Favorite filter
    if (isFavorite === false) {
      whereClauses.push('f.video_id IS NULL');
    }

    // Relationship filters - array-based
    if (needsCreatorJoin && creatorIds!.length > 0) {
      if (matchMode === 'any') {
        whereClauses.push(`vc.creator_id IN (${creatorIds!.map(() => '?').join(',')})`);
        whereParams.push(...creatorIds!);
      } else {
        whereClauses.push(`vc.creator_id IN (${creatorIds!.map(() => '?').join(',')}) OR vc.creator_id IS NULL`);
        whereParams.push(...creatorIds!);
      }
    }

    if (needsTagJoin && tagIds!.length > 0) {
      if (matchMode === 'any') {
        whereClauses.push(`vt.tag_id IN (${tagIds!.map(() => '?').join(',')})`);
        whereParams.push(...tagIds!);
      } else {
        whereClauses.push(`vt.tag_id IN (${tagIds!.map(() => '?').join(',')}) OR vt.tag_id IS NULL`);
        whereParams.push(...tagIds!);
      }
    }

    if (needsStudioJoin && studioIds!.length > 0) {
      if (matchMode === 'any') {
        whereClauses.push(`vs.studio_id IN (${studioIds!.map(() => '?').join(',')})`);
        whereParams.push(...studioIds!);
      } else {
        whereClauses.push(`vs.studio_id IN (${studioIds!.map(() => '?').join(',')}) OR vs.studio_id IS NULL`);
        whereParams.push(...studioIds!);
      }
    }

    const whereClause = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    // GROUP BY clause (needed when using array filters with 'all' mode)
    let groupByClause = '';
    let havingClause = '';

    if (needsGroupBy) {
      groupByClause = 'GROUP BY v.id';

      const havingConditions: string[] = [];

      if (needsCreatorJoin && creatorIds!.length > 0) {
        havingConditions.push(`COUNT(DISTINCT vc.creator_id) >= ${creatorIds!.length}`);
      }

      if (needsTagJoin && tagIds!.length > 0) {
        havingConditions.push(`COUNT(DISTINCT vt.tag_id) >= ${tagIds!.length}`);
      }

      if (needsStudioJoin && studioIds!.length > 0) {
        havingConditions.push(`COUNT(DISTINCT vs.studio_id) >= ${studioIds!.length}`);
      }

      if (havingConditions.length > 0) {
        havingClause = `HAVING ${havingConditions.join(' AND ')}`;
      }
    }

    // Get total count (need separate query without pagination)
    const countQuery = `
      SELECT COUNT(${needsGroupBy ? 'DISTINCT v.id' : '*'}) as count
      ${fromClause}
      ${whereClause}
      ${needsGroupBy && !havingClause ? groupByClause : ''}
      ${havingClause}
    `;

    const countResult = this.db.prepare(countQuery).get(...whereParams) as { count: number };
    const total = countResult.count;
    const totalPages = Math.ceil(total / limit);

    // Get videos with sorting and pagination
    const validSortColumns = [
      'created_at',
      'file_name',
      'duration_seconds',
      'file_size_bytes',
      'indexed_at',
      'width',
      'height',
      'bitrate',
      'fps'
    ];
    const sortColumn = validSortColumns.includes(sort) ? sort : 'created_at';
    const sortOrder = order === 'asc' ? 'ASC' : 'DESC';

    const selectQuery = `
      SELECT ${needsGroupBy ? 'DISTINCT' : ''} v.*, t.id as thumbnail_id, t.file_path as thumbnail_file_path
      ${fromClause}
      ${whereClause}
      ${groupByClause}
      ${havingClause}
      ORDER BY v.${sortColumn} ${sortOrder}
      LIMIT ? OFFSET ?
    `;

    const videos = this.db
      .prepare(selectQuery)
      .all(...whereParams, limit, offset) as (Video & { thumbnail_file_path: string | null })[];

    return {
      data: videos.map(v => ({
        ...v,
        thumbnail_url: v.thumbnail_id ? `${API_PREFIX}/thumbnails/${v.thumbnail_id}/image` : null,
        thumbnail_base64: this.readThumbnailAsBase64(v.thumbnail_file_path),
        is_favorite: this.db.prepare('SELECT 1 FROM favorites WHERE user_id = ? AND video_id = ?').get(userId, v.id) ? true : false,
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages,
      },
    };
  }

  async findById(id: number, userId?: number): Promise<Video & { thumbnail_url?: string | null; thumbnail_base64?: string | null }> {
    const video = this.db
      .prepare(`
        SELECT v.*, t.id as thumbnail_id, t.file_path as thumbnail_file_path
        FROM videos v
        LEFT JOIN thumbnails t ON v.id = t.video_id
        WHERE v.id = ?
      `)
      .get(id) as (Video & { thumbnail_file_path: string | null }) | undefined;

    if (!video) {
      throw new NotFoundError(`Video not found with id: ${id}`);
    }

    let isFavorite = false;
    if (userId) {
      isFavorite = this.db.prepare('SELECT 1 FROM favorites WHERE user_id = ? AND video_id = ?').get(userId, id) ? true : false;
    }

    video.is_favorite = isFavorite;

    return {
      ...video,
      thumbnail_url: video.thumbnail_id ? `${API_PREFIX}/thumbnails/${video.thumbnail_id}/image` : null,
      thumbnail_base64: this.readThumbnailAsBase64(video.thumbnail_file_path)
    };
  }

  async update(id: number, input: UpdateVideoInput): Promise<Video> {
    await this.findById(id); // Ensure exists

    const updates: string[] = [];
    const values: any[] = [];

    if (input.title !== undefined) {
      updates.push('title = ?');
      values.push(input.title);
    }

    if (input.description !== undefined) {
      updates.push('description = ?');
      values.push(input.description);
    }

    if (input.themes !== undefined) {
      updates.push('themes = ?');
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
         SET ${updates.join(', ')}
         WHERE id = ?`
      )
      .run(...values);

    return this.findById(id);
  }

  async delete(id: number): Promise<void> {
    await this.findById(id); // Ensure exists

    this.db.prepare('DELETE FROM videos WHERE id = ?').run(id);
  }

  async verifyAvailability(id: number): Promise<Video> {
    const video = await this.findById(id);

    const fs = await import('fs');
    const exists = fs.existsSync(video.file_path);

    this.db
      .prepare(
        "UPDATE videos SET is_available = ?, last_verified_at = datetime('now') WHERE id = ?"
      )
      .run(exists ? 1 : 0, id);

    return this.findById(id);
  }

  // ========== CUSTOM METADATA ==========

  async getMetadata(videoId: number): Promise<{ key: string; value: string }[]> {
    await this.findById(videoId); // Ensure video exists

    return this.db
      .prepare('SELECT key, value FROM video_metadata WHERE video_id = ? ORDER BY key ASC')
      .all(videoId) as { key: string; value: string }[];
  }

  async setMetadata(videoId: number, key: string, value: string): Promise<void> {
    await this.findById(videoId); // Ensure video exists

    // Upsert: insert or update
    this.db
      .prepare(
        `INSERT INTO video_metadata (video_id, key, value)
         VALUES (?, ?, ?)
         ON CONFLICT(video_id, key) DO UPDATE SET
           value = excluded.value,
           updated_at = datetime('now')`
      )
      .run(videoId, key, value);
  }

  async deleteMetadata(videoId: number, key: string): Promise<void> {
    await this.findById(videoId); // Ensure video exists

    const result = this.db
      .prepare('DELETE FROM video_metadata WHERE video_id = ? AND key = ?')
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
         ORDER BY s.name ASC`
      )
      .all(videoId);

    return studios;
  }

  // Bulk Actions
  async bulkDelete(ids: number[]): Promise<void> {
    if (ids.length === 0) return;

    const placeholders = ids.map(() => '?').join(',');
    this.db.prepare(`DELETE FROM videos WHERE id IN (${placeholders})`).run(...ids);
  }

  async bulkUpdateCreators(input: { videoIds: number[]; creatorIds: number[]; action: 'add' | 'remove' }): Promise<void> {
    const { videoIds, creatorIds, action } = input;
    if (videoIds.length === 0 || creatorIds.length === 0) return;

    const update = this.db.transaction(() => {
      if (action === 'add') {
        const insert = this.db.prepare('INSERT OR IGNORE INTO video_creators (video_id, creator_id) VALUES (?, ?)');
        for (const videoId of videoIds) {
          for (const creatorId of creatorIds) {
            insert.run(videoId, creatorId);
          }
        }
      } else {
        const deleteStmt = this.db.prepare(
          `DELETE FROM video_creators WHERE video_id = ? AND creator_id IN (${creatorIds.map(() => '?').join(',')})`
        );
        for (const videoId of videoIds) {
          deleteStmt.run(videoId, ...creatorIds);
        }
      }
    });

    update();
  }

  async bulkUpdateTags(input: { videoIds: number[]; tagIds: number[]; action: 'add' | 'remove' }): Promise<void> {
    const { videoIds, tagIds, action } = input;
    if (videoIds.length === 0 || tagIds.length === 0) return;

    const update = this.db.transaction(() => {
      if (action === 'add') {
        const insert = this.db.prepare('INSERT OR IGNORE INTO video_tags (video_id, tag_id) VALUES (?, ?)');
        for (const videoId of videoIds) {
          for (const tagId of tagIds) {
            insert.run(videoId, tagId);
          }
        }
      } else {
        const deleteStmt = this.db.prepare(
          `DELETE FROM video_tags WHERE video_id = ? AND tag_id IN (${tagIds.map(() => '?').join(',')})`
        );
        for (const videoId of videoIds) {
          deleteStmt.run(videoId, ...tagIds);
        }
      }
    });

    update();
  }

  async bulkUpdateStudios(input: { videoIds: number[]; studioIds: number[]; action: 'add' | 'remove' }): Promise<void> {
    const { videoIds, studioIds, action } = input;
    if (videoIds.length === 0 || studioIds.length === 0) return;

    const update = this.db.transaction(() => {
      if (action === 'add') {
        const insert = this.db.prepare('INSERT OR IGNORE INTO video_studios (video_id, studio_id) VALUES (?, ?)');
        for (const videoId of videoIds) {
          for (const studioId of studioIds) {
            insert.run(videoId, studioId);
          }
        }
      } else {
        const deleteStmt = this.db.prepare(
          `DELETE FROM video_studios WHERE video_id = ? AND studio_id IN (${studioIds.map(() => '?').join(',')})`
        );
        for (const videoId of videoIds) {
          deleteStmt.run(videoId, ...studioIds);
        }
      }
    });

    update();
  }

  async bulkUpdateFavorites(userId: number, input: { videoIds: number[]; isFavorite: boolean }): Promise<void> {
    const { videoIds, isFavorite } = input;
    if (videoIds.length === 0) return;

    const update = this.db.transaction(() => {
      if (isFavorite) {
        const insert = this.db.prepare('INSERT OR IGNORE INTO favorites (user_id, video_id) VALUES (?, ?)');
        for (const videoId of videoIds) {
          insert.run(userId, videoId);
        }
      } else {
        const placeholders = videoIds.map(() => '?').join(',');
        this.db.prepare(`DELETE FROM favorites WHERE user_id = ? AND video_id IN (${placeholders})`).run(userId, ...videoIds);
      }
    });

    update();
  }
}

export const videosService = new VideosService();
