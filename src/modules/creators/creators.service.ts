import { getDatabase } from '@/config/database';
import { NotFoundError, ConflictError } from '@/utils/errors';
import { env } from '@/config/env';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { mkdirSync } from 'fs';
import type {
  Creator,
  CreateCreatorInput,
  UpdateCreatorInput,
  SocialLink,
  CreateSocialLinkInput,
  UpdateSocialLinkInput,
  ListCreatorsOptions,
  PaginatedCreators
} from './creators.types';
import type { Video } from '@/modules/videos/videos.types';
import type {
  CreatorPlatform,
  CreateCreatorPlatformInput,
  UpdateCreatorPlatformInput
} from '@/modules/platforms/platforms.types';
import type { Studio } from '@/modules/studios/studios.types';

export class CreatorsService {
  private get db() {
    return getDatabase();
  }

  async list(options: ListCreatorsOptions = {}): Promise<PaginatedCreators> {
    const {
      page = 1,
      limit = 20,
      search,
      sort = 'name',
      order = 'asc',
      minVideoCount,
      maxVideoCount,
      hasProfilePicture,
      studioIds,
    } = options;

    const offset = (page - 1) * limit;

    // Determine required JOINs
    const needsVideoCountJoin = minVideoCount !== undefined || maxVideoCount !== undefined || sort === 'video_count';
    const needsStudioJoin = studioIds && studioIds.length > 0;

    // Build FROM clause with JOINs
    let fromClause = 'FROM creators c';

    // Video count subquery JOIN
    if (needsVideoCountJoin) {
      fromClause += '\nLEFT JOIN (SELECT creator_id, COUNT(*) as video_count FROM video_creators GROUP BY creator_id) vc ON c.id = vc.creator_id';
    }

    // Studio relationship JOIN
    if (needsStudioJoin) {
      fromClause += '\nINNER JOIN creator_studios cs ON c.id = cs.creator_id';
    }

    // Build WHERE clause
    const whereClauses: string[] = [];
    const whereParams: any[] = [];

    // Search filter (name)
    if (search) {
      whereClauses.push('c.name LIKE ?');
      whereParams.push(`%${search}%`);
    }

    // Profile picture presence
    if (hasProfilePicture === true) {
      whereClauses.push('c.profile_picture_path IS NOT NULL');
    } else if (hasProfilePicture === false) {
      whereClauses.push('c.profile_picture_path IS NULL');
    }

    // Video count filters
    if (minVideoCount !== undefined) {
      whereClauses.push('COALESCE(vc.video_count, 0) >= ?');
      whereParams.push(minVideoCount);
    }
    if (maxVideoCount !== undefined) {
      whereClauses.push('COALESCE(vc.video_count, 0) <= ?');
      whereParams.push(maxVideoCount);
    }

    // Studio filter
    if (needsStudioJoin && studioIds!.length > 0) {
      whereClauses.push(`cs.studio_id IN (${studioIds!.map(() => '?').join(',')})`);
      whereParams.push(...studioIds!);
    }

    const whereClause = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    // GROUP BY if studio join (to avoid duplicates)
    const groupByClause = needsStudioJoin ? 'GROUP BY c.id' : '';

    // Get total count
    const countQuery = `
      SELECT COUNT(${needsStudioJoin ? 'DISTINCT c.id' : '*'}) as count
      ${fromClause}
      ${whereClause}
    `;

    const countResult = this.db.prepare(countQuery).get(...whereParams) as { count: number };
    const total = countResult.count;
    const totalPages = Math.ceil(total / limit);

    // Get creators with sorting and pagination
    const validSortColumns = ['name', 'created_at', 'video_count'];
    const sortColumn = validSortColumns.includes(sort) ? sort : 'name';

    // Map sort column to actual column name
    let sortExpression = 'c.name';
    if (sortColumn === 'video_count') {
      sortExpression = 'COALESCE(vc.video_count, 0)';
    } else if (sortColumn === 'created_at') {
      sortExpression = 'c.created_at';
    }

    const sortOrder = order === 'asc' ? 'ASC' : 'DESC';

    const selectQuery = `
      SELECT ${needsStudioJoin ? 'DISTINCT' : ''} c.*${needsVideoCountJoin ? ', COALESCE(vc.video_count, 0) as video_count' : ''}
      ${fromClause}
      ${whereClause}
      ${groupByClause}
      ORDER BY ${sortExpression} ${sortOrder}
      LIMIT ? OFFSET ?
    `;

    const creators = this.db
      .prepare(selectQuery)
      .all(...whereParams, limit, offset) as Creator[];

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
    const creator = this.db
      .prepare('SELECT * FROM creators WHERE id = ?')
      .get(id) as Creator | undefined;

    if (!creator) {
      throw new NotFoundError(`Creator not found with id: ${id}`);
    }

    return creator;
  }

  async create(input: CreateCreatorInput): Promise<Creator> {
    try {
      const result = this.db
        .prepare('INSERT INTO creators (name, description) VALUES (?, ?)')
        .run(input.name, input.description || null);

      return this.findById(result.lastInsertRowid as number);
    } catch (error: any) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        throw new ConflictError(`Creator with name "${input.name}" already exists`);
      }
      throw error;
    }
  }

  async update(id: number, input: UpdateCreatorInput): Promise<Creator> {
    await this.findById(id); // Ensure exists

    const updates: string[] = [];
    const values: any[] = [];

    if (input.name !== undefined) {
      updates.push('name = ?');
      values.push(input.name);
    }

    if (input.description !== undefined) {
      updates.push('description = ?');
      values.push(input.description);
    }

    if (updates.length === 0) {
      return this.findById(id);
    }

    updates.push("updated_at = datetime('now')");
    values.push(id);

    try {
      this.db
        .prepare(`UPDATE creators SET ${updates.join(', ')} WHERE id = ?`)
        .run(...values);

      return this.findById(id);
    } catch (error: any) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        throw new ConflictError(`Creator with name "${input.name}" already exists`);
      }
      throw error;
    }
  }

  async delete(id: number): Promise<void> {
    await this.findById(id); // Ensure exists
    this.db.prepare('DELETE FROM creators WHERE id = ?').run(id);
  }

  async getVideos(creatorId: number): Promise<Video[]> {
    await this.findById(creatorId); // Ensure creator exists

    return this.db
      .prepare(
        `SELECT v.* FROM videos v
         INNER JOIN video_creators vc ON v.id = vc.video_id
         WHERE vc.creator_id = ?
         ORDER BY v.created_at DESC`
      )
      .all(creatorId) as Video[];
  }

  async addToVideo(videoId: number, creatorId: number): Promise<void> {
    // Verify creator exists
    await this.findById(creatorId);

    try {
      this.db
        .prepare('INSERT INTO video_creators (video_id, creator_id) VALUES (?, ?)')
        .run(videoId, creatorId);
    } catch (error: any) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        throw new ConflictError('Creator is already associated with this video');
      }
      if (error.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
        throw new NotFoundError(`Video not found with id: ${videoId}`);
      }
      throw error;
    }
  }

  async removeFromVideo(videoId: number, creatorId: number): Promise<void> {
    const result = this.db
      .prepare('DELETE FROM video_creators WHERE video_id = ? AND creator_id = ?')
      .run(videoId, creatorId);

    if (result.changes === 0) {
      throw new NotFoundError('Creator association not found');
    }
  }

  async getCreatorsForVideo(videoId: number): Promise<Creator[]> {
    return this.db
      .prepare(
        `SELECT c.* FROM creators c
         INNER JOIN video_creators vc ON c.id = vc.creator_id
         WHERE vc.video_id = ?
         ORDER BY c.name ASC`
      )
      .all(videoId) as Creator[];
  }

  // Profile Picture Methods
  async uploadProfilePicture(id: number, fileBuffer: Buffer, filename: string): Promise<Creator> {
    const creator = await this.findById(id);

    // Ensure directory exists
    if (!existsSync(env.PROFILE_PICTURES_DIR)) {
      mkdirSync(env.PROFILE_PICTURES_DIR, { recursive: true });
    }

    // Delete old picture if exists
    if (creator.profile_picture_path && existsSync(creator.profile_picture_path)) {
      unlinkSync(creator.profile_picture_path);
    }

    // Generate unique filename
    const ext = filename.split('.').pop() || 'jpg';
    const newFilename = `creator_${id}_${Date.now()}.${ext}`;
    const filePath = join(env.PROFILE_PICTURES_DIR, newFilename);

    // Save file
    writeFileSync(filePath, fileBuffer);

    // Update database
    this.db
      .prepare(`UPDATE creators SET profile_picture_path = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(filePath, id);

    return this.findById(id);
  }

  async deleteProfilePicture(id: number): Promise<Creator> {
    const creator = await this.findById(id);

    if (creator.profile_picture_path && existsSync(creator.profile_picture_path)) {
      unlinkSync(creator.profile_picture_path);
    }

    this.db
      .prepare(`UPDATE creators SET profile_picture_path = NULL, updated_at = datetime('now') WHERE id = ?`)
      .run(id);

    return this.findById(id);
  }

  // Platform Profile Methods
  async addPlatformProfile(creatorId: number, input: CreateCreatorPlatformInput): Promise<CreatorPlatform> {
    await this.findById(creatorId); // Ensure creator exists

    try {
      const result = this.db
        .prepare(
          `INSERT INTO creator_platforms (creator_id, platform_id, username, profile_url, is_primary)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(creatorId, input.platform_id, input.username, input.profile_url, input.is_primary ? 1 : 0);

      return this.findPlatformProfileById(result.lastInsertRowid as number);
    } catch (error: any) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        throw new ConflictError('Creator already has a profile on this platform');
      }
      if (error.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
        throw new NotFoundError('Platform not found');
      }
      throw error;
    }
  }

  async updatePlatformProfile(id: number, input: UpdateCreatorPlatformInput): Promise<CreatorPlatform> {
    await this.findPlatformProfileById(id); // Ensure exists

    const updates: string[] = [];
    const values: any[] = [];

    if (input.username !== undefined) {
      updates.push('username = ?');
      values.push(input.username);
    }

    if (input.profile_url !== undefined) {
      updates.push('profile_url = ?');
      values.push(input.profile_url);
    }

    if (input.is_primary !== undefined) {
      updates.push('is_primary = ?');
      values.push(input.is_primary ? 1 : 0);
    }

    if (updates.length === 0) {
      return this.findPlatformProfileById(id);
    }

    updates.push("updated_at = datetime('now')");
    values.push(id);

    this.db
      .prepare(`UPDATE creator_platforms SET ${updates.join(', ')} WHERE id = ?`)
      .run(...values);

    return this.findPlatformProfileById(id);
  }

  async deletePlatformProfile(id: number): Promise<void> {
    await this.findPlatformProfileById(id); // Ensure exists
    this.db.prepare('DELETE FROM creator_platforms WHERE id = ?').run(id);
  }

  async getPlatformProfiles(creatorId: number): Promise<CreatorPlatform[]> {
    await this.findById(creatorId); // Ensure creator exists

    const profiles = this.db
      .prepare(
        `SELECT cp.*, p.name as platform_name
         FROM creator_platforms cp
         LEFT JOIN platforms p ON cp.platform_id = p.id
         WHERE cp.creator_id = ?
         ORDER BY cp.is_primary DESC, p.name ASC`
      )
      .all(creatorId) as any[];

    // Convert is_primary from SQLite integer (0/1) to boolean
    return profiles.map(profile => ({
      ...profile,
      is_primary: Boolean(profile.is_primary)
    })) as CreatorPlatform[];
  }

  private async findPlatformProfileById(id: number): Promise<CreatorPlatform> {
    const profile = this.db
      .prepare(
        `SELECT cp.*, p.name as platform_name
         FROM creator_platforms cp
         LEFT JOIN platforms p ON cp.platform_id = p.id
         WHERE cp.id = ?`
      )
      .get(id) as any;

    if (!profile) {
      throw new NotFoundError(`Platform profile not found with id: ${id}`);
    }

    // Convert is_primary from SQLite integer (0/1) to boolean
    return {
      ...profile,
      is_primary: Boolean(profile.is_primary)
    } as CreatorPlatform;
  }

  // Social Links Methods
  async addSocialLink(creatorId: number, input: CreateSocialLinkInput): Promise<SocialLink> {
    await this.findById(creatorId); // Ensure creator exists

    const result = this.db
      .prepare(
        `INSERT INTO creator_social_links (creator_id, platform_name, url)
         VALUES (?, ?, ?)`
      )
      .run(creatorId, input.platform_name, input.url);

    return this.findSocialLinkById(result.lastInsertRowid as number);
  }

  async updateSocialLink(id: number, input: UpdateSocialLinkInput): Promise<SocialLink> {
    await this.findSocialLinkById(id); // Ensure exists

    const updates: string[] = [];
    const values: any[] = [];

    if (input.platform_name !== undefined) {
      updates.push('platform_name = ?');
      values.push(input.platform_name);
    }

    if (input.url !== undefined) {
      updates.push('url = ?');
      values.push(input.url);
    }

    if (updates.length === 0) {
      return this.findSocialLinkById(id);
    }

    values.push(id);

    this.db
      .prepare(`UPDATE creator_social_links SET ${updates.join(', ')} WHERE id = ?`)
      .run(...values);

    return this.findSocialLinkById(id);
  }

  async deleteSocialLink(id: number): Promise<void> {
    await this.findSocialLinkById(id); // Ensure exists
    this.db.prepare('DELETE FROM creator_social_links WHERE id = ?').run(id);
  }

  async getSocialLinks(creatorId: number): Promise<SocialLink[]> {
    await this.findById(creatorId); // Ensure creator exists

    return this.db
      .prepare(
        `SELECT * FROM creator_social_links
         WHERE creator_id = ?
         ORDER BY platform_name ASC`
      )
      .all(creatorId) as SocialLink[];
  }

  private async findSocialLinkById(id: number): Promise<SocialLink> {
    const link = this.db
      .prepare('SELECT * FROM creator_social_links WHERE id = ?')
      .get(id) as SocialLink | undefined;

    if (!link) {
      throw new NotFoundError(`Social link not found with id: ${id}`);
    }

    return link;
  }

  // Studio Relationship Methods
  async linkStudio(creatorId: number, studioId: number): Promise<void> {
    await this.findById(creatorId); // Ensure creator exists

    try {
      this.db
        .prepare('INSERT INTO creator_studios (creator_id, studio_id) VALUES (?, ?)')
        .run(creatorId, studioId);
    } catch (error: any) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        throw new ConflictError('Creator is already linked to this studio');
      }
      if (error.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
        throw new NotFoundError(`Studio not found with id: ${studioId}`);
      }
      throw error;
    }
  }

  async unlinkStudio(creatorId: number, studioId: number): Promise<void> {
    const result = this.db
      .prepare('DELETE FROM creator_studios WHERE creator_id = ? AND studio_id = ?')
      .run(creatorId, studioId);

    if (result.changes === 0) {
      throw new NotFoundError('Creator-studio relationship not found');
    }
  }

  async getStudios(creatorId: number): Promise<Studio[]> {
    await this.findById(creatorId); // Ensure creator exists

    return this.db
      .prepare(
        `SELECT s.* FROM studios s
         INNER JOIN creator_studios cs ON s.id = cs.studio_id
         WHERE cs.creator_id = ?
         ORDER BY s.name ASC`
      )
      .all(creatorId) as Studio[];
  }
}

export const creatorsService = new CreatorsService();
