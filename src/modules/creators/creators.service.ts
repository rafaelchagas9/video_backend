import { getDatabase } from '@/config/database';
import { NotFoundError, ConflictError } from '@/utils/errors';
import { env } from '@/config/env';
import { logger } from '@/utils/logger';
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
  PaginatedCreators,
  BulkPlatformItem,
  BulkSocialLinkItem,
  BulkOperationResult,
  BulkCreatorImportItem,
  BulkImportPreviewItem,
  BulkImportResult
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
      missing,
      complete,
    } = options;

    const offset = (page - 1) * limit;

    // Always need these subqueries for enhanced response
    const videoCountSubquery = `
      LEFT JOIN (
        SELECT creator_id, COUNT(*) as video_count 
        FROM video_creators 
        GROUP BY creator_id
      ) vc ON c.id = vc.creator_id
    `;
    
    const platformCountSubquery = `
      LEFT JOIN (
        SELECT creator_id, COUNT(*) as platform_count 
        FROM creator_platforms 
        GROUP BY creator_id
      ) pc ON c.id = pc.creator_id
    `;
    
    const socialLinkCountSubquery = `
      LEFT JOIN (
        SELECT creator_id, COUNT(*) as social_link_count 
        FROM creator_social_links 
        GROUP BY creator_id
      ) sc ON c.id = sc.creator_id
    `;

    const needsStudioJoin = studioIds && studioIds.length > 0;
    const needsPlatformSearchJoin = !!search;

    // Build FROM clause with JOINs
    let fromClause = `FROM creators c
      ${videoCountSubquery}
      ${platformCountSubquery}
      ${socialLinkCountSubquery}`;

    // Studio relationship JOIN
    if (needsStudioJoin) {
      fromClause += '\nINNER JOIN creator_studios cs ON c.id = cs.creator_id';
    }

    // Platform search JOIN (for username matching)
    if (needsPlatformSearchJoin) {
      fromClause += '\nLEFT JOIN creator_platforms cp_search ON c.id = cp_search.creator_id';
    }

    // Build WHERE clause
    const whereClauses: string[] = [];
    const whereParams: any[] = [];

    // Search filter (name OR platform username)
    if (search) {
      whereClauses.push('(c.name LIKE ? OR cp_search.username LIKE ?)');
      whereParams.push(`%${search}%`, `%${search}%`);
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

    // Missing filter
    if (missing) {
      switch (missing) {
        case 'picture':
          whereClauses.push('c.profile_picture_path IS NULL');
          break;
        case 'platform':
          whereClauses.push('COALESCE(pc.platform_count, 0) = 0');
          break;
        case 'social':
          whereClauses.push('COALESCE(sc.social_link_count, 0) = 0');
          break;
        case 'linked':
          whereClauses.push('COALESCE(vc.video_count, 0) = 0');
          break;
        case 'any':
          // Incomplete: missing picture OR (missing platform AND social) OR missing linked videos
          whereClauses.push(`(
            c.profile_picture_path IS NULL 
            OR (COALESCE(pc.platform_count, 0) = 0 AND COALESCE(sc.social_link_count, 0) = 0)
            OR COALESCE(vc.video_count, 0) = 0
          )`);
          break;
      }
    }

    // Complete filter
    if (complete !== undefined) {
      // Complete: has picture AND (has platform OR social) AND has videos
      const completenessCondition = `(
        c.profile_picture_path IS NOT NULL 
        AND (COALESCE(pc.platform_count, 0) > 0 OR COALESCE(sc.social_link_count, 0) > 0)
        AND COALESCE(vc.video_count, 0) > 0
      )`;
      
      if (complete) {
        whereClauses.push(completenessCondition);
      } else {
        whereClauses.push(`NOT ${completenessCondition}`);
      }
    }

    const whereClause = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    // GROUP BY to handle platform search join duplicates
    const groupByClause = needsPlatformSearchJoin || needsStudioJoin ? 'GROUP BY c.id' : '';

    // Get total count
    const countQuery = `
      SELECT COUNT(DISTINCT c.id) as count
      ${fromClause}
      ${whereClause}
    `;

    const countResult = this.db.prepare(countQuery).get(...whereParams) as { count: number };
    const total = countResult.count;
    const totalPages = Math.ceil(total / limit);

    // Get creators with sorting and pagination
    const validSortColumns = ['name', 'created_at', 'updated_at', 'video_count'];
    const sortColumn = validSortColumns.includes(sort) ? sort : 'name';

    // Map sort column to actual column name
    let sortExpression = 'c.name';
    if (sortColumn === 'video_count') {
      sortExpression = 'COALESCE(vc.video_count, 0)';
    } else if (sortColumn === 'created_at') {
      sortExpression = 'c.created_at';
    } else if (sortColumn === 'updated_at') {
      sortExpression = 'c.updated_at';
    }

    const sortOrder = order === 'asc' ? 'ASC' : 'DESC';

    const selectQuery = `
      SELECT 
        c.*,
        COALESCE(vc.video_count, 0) as linked_video_count,
        COALESCE(pc.platform_count, 0) as platform_count,
        COALESCE(sc.social_link_count, 0) as social_link_count
      ${fromClause}
      ${whereClause}
      ${groupByClause}
      ORDER BY ${sortExpression} ${sortOrder}
      LIMIT ? OFFSET ?
    `;

    const rawCreators = this.db
      .prepare(selectQuery)
      .all(...whereParams, limit, offset) as any[];

    // Compute completeness for each creator
    const creators = rawCreators.map(creator => {
      const hasPicture = creator.profile_picture_path !== null;
      const hasPlatformOrSocial = creator.platform_count > 0 || creator.social_link_count > 0;
      const hasVideos = creator.linked_video_count > 0;
      
      const missingFields: string[] = [];
      if (!hasPicture) missingFields.push('picture');
      if (!hasPlatformOrSocial) missingFields.push('platform_or_social');
      if (!hasVideos) missingFields.push('linked_videos');

      return {
        ...creator,
        has_profile_picture: hasPicture,
        completeness: {
          is_complete: hasPicture && hasPlatformOrSocial && hasVideos,
          missing_fields: missingFields,
        },
      };
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
    const creator = await this.findById(id); // Ensure exists

    // Delete profile picture file if exists
    if (creator.profile_picture_path) {
      try {
        if (existsSync(creator.profile_picture_path)) {
          unlinkSync(creator.profile_picture_path);
        }
      } catch (error) {
        logger.warn({ error, path: creator.profile_picture_path }, 'Failed to delete creator profile picture file');
        // Continue with database deletion even if file deletion fails
      }
    }

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

  // Bulk Operation Methods
  async bulkUpsertPlatforms(creatorId: number, items: BulkPlatformItem[]): Promise<BulkOperationResult<CreatorPlatform>> {
    await this.findById(creatorId); // Ensure creator exists

    const created: CreatorPlatform[] = [];
    const updated: CreatorPlatform[] = [];
    const errors: Array<{ index: number; error: string }> = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      try {
        // Check if exists by platform_id + username
        const existing = this.db
          .prepare(
            `SELECT id FROM creator_platforms 
             WHERE creator_id = ? AND platform_id = ? AND username = ?`
          )
          .get(creatorId, item.platform_id, item.username) as { id: number } | undefined;

        if (existing) {
          // Update existing
          this.db
            .prepare(
              `UPDATE creator_platforms 
               SET profile_url = ?, is_primary = ?, updated_at = datetime('now') 
               WHERE id = ?`
            )
            .run(item.profile_url, item.is_primary ? 1 : 0, existing.id);
          
          updated.push(await this.findPlatformProfileById(existing.id));
        } else {
          // Create new
          const result = this.db
            .prepare(
              `INSERT INTO creator_platforms (creator_id, platform_id, username, profile_url, is_primary)
               VALUES (?, ?, ?, ?, ?)`
            )
            .run(creatorId, item.platform_id, item.username, item.profile_url, item.is_primary ? 1 : 0);
          
          created.push(await this.findPlatformProfileById(result.lastInsertRowid as number));
        }
      } catch (error: any) {
        errors.push({ index: i, error: error.message || 'Unknown error' });
      }
    }

    return { created, updated, errors };
  }

  async bulkUpsertSocialLinks(creatorId: number, items: BulkSocialLinkItem[]): Promise<BulkOperationResult<SocialLink>> {
    await this.findById(creatorId); // Ensure creator exists

    const created: SocialLink[] = [];
    const updated: SocialLink[] = [];
    const errors: Array<{ index: number; error: string }> = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      try {
        // Check if exists by platform_name + url
        const existing = this.db
          .prepare(
            `SELECT id FROM creator_social_links 
             WHERE creator_id = ? AND platform_name = ? AND url = ?`
          )
          .get(creatorId, item.platform_name, item.url) as { id: number } | undefined;

        if (existing) {
          // Already exists with same data, add to updated
          updated.push(await this.findSocialLinkById(existing.id));
        } else {
          // Check if exists by platform_name only (update url)
          const existingByPlatform = this.db
            .prepare(
              `SELECT id FROM creator_social_links 
               WHERE creator_id = ? AND platform_name = ?`
            )
            .get(creatorId, item.platform_name) as { id: number } | undefined;

          if (existingByPlatform) {
            // Update URL
            this.db
              .prepare(`UPDATE creator_social_links SET url = ? WHERE id = ?`)
              .run(item.url, existingByPlatform.id);
            updated.push(await this.findSocialLinkById(existingByPlatform.id));
          } else {
            // Create new
            const result = this.db
              .prepare(
                `INSERT INTO creator_social_links (creator_id, platform_name, url)
                 VALUES (?, ?, ?)`
              )
              .run(creatorId, item.platform_name, item.url);
            
            created.push(await this.findSocialLinkById(result.lastInsertRowid as number));
          }
        }
      } catch (error: any) {
        errors.push({ index: i, error: error.message || 'Unknown error' });
      }
    }

    return { created, updated, errors };
  }

  async setPictureFromUrl(creatorId: number, url: string): Promise<Creator> {
    const creator = await this.findById(creatorId);

    // Download image from URL
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to download image: ${response.status} ${response.statusText}`);
    }

    const contentType = response.headers.get('content-type');
    if (!contentType || !contentType.startsWith('image/')) {
      throw new Error('URL does not point to a valid image');
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    
    // Validate minimum size
    if (buffer.length < 100) {
      throw new Error('Downloaded image is too small');
    }

    // Determine extension from content type
    let ext = 'jpg';
    if (contentType.includes('png')) ext = 'png';
    else if (contentType.includes('webp')) ext = 'webp';
    else if (contentType.includes('gif')) ext = 'gif';

    // Ensure directory exists
    if (!existsSync(env.PROFILE_PICTURES_DIR)) {
      mkdirSync(env.PROFILE_PICTURES_DIR, { recursive: true });
    }

    // Delete old picture if exists
    if (creator.profile_picture_path && existsSync(creator.profile_picture_path)) {
      unlinkSync(creator.profile_picture_path);
    }

    // Generate unique filename
    const newFilename = `creator_${creatorId}_${Date.now()}.${ext}`;
    const filePath = join(env.PROFILE_PICTURES_DIR, newFilename);

    // Save file
    writeFileSync(filePath, buffer);

    // Update database
    this.db
      .prepare(`UPDATE creators SET profile_picture_path = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(filePath, creatorId);

    return this.findById(creatorId);
  }

  // Bulk Import with Preview
  async bulkImport(items: BulkCreatorImportItem[], mode: 'merge' | 'replace', dryRun: boolean): Promise<BulkImportResult> {
    const previewItems: BulkImportPreviewItem[] = [];
    let willCreate = 0;
    let willUpdate = 0;
    let errors = 0;

    // First pass: validate and compute preview
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const validationErrors: string[] = [];
      const missingDependencies: string[] = [];
      let existingCreator: Creator | null = null;
      let action: 'create' | 'update' = 'create';

      // Check if updating existing creator
      if (item.id) {
        try {
          existingCreator = await this.findById(item.id);
          action = 'update';
        } catch {
          validationErrors.push(`Creator with id ${item.id} not found`);
        }
      } else {
        // Check if creator with same name exists
        const existing = this.db
          .prepare('SELECT * FROM creators WHERE name = ?')
          .get(item.name) as Creator | undefined;
        if (existing) {
          existingCreator = existing;
          action = 'update';
        }
      }

      // Validate video IDs exist
      if (item.link_video_ids && item.link_video_ids.length > 0) {
        for (const videoId of item.link_video_ids) {
          const video = this.db.prepare('SELECT id FROM videos WHERE id = ?').get(videoId);
          if (!video) {
            missingDependencies.push(`Video id ${videoId} not found`);
          }
        }
      }

      // Validate platform IDs exist
      if (item.platforms && item.platforms.length > 0) {
        for (const platform of item.platforms) {
          const p = this.db.prepare('SELECT id FROM platforms WHERE id = ?').get(platform.platform_id);
          if (!p) {
            missingDependencies.push(`Platform id ${platform.platform_id} not found`);
          }
        }
      }

      // Compute changes
      const changes: BulkImportPreviewItem['changes'] = {};

      if (existingCreator) {
        if (existingCreator.name !== item.name) {
          changes.name = { from: existingCreator.name, to: item.name };
        }
        if (item.description !== undefined && existingCreator.description !== (item.description ?? null)) {
          changes.description = { from: existingCreator.description, to: item.description ?? null };
        }
        if (item.profile_picture_url) {
          changes.profile_picture = { action: 'set' };
        }

        // Compute platform changes
        if (item.platforms) {
          const existingPlatforms = await this.getPlatformProfiles(existingCreator.id);
          let add = 0, update = 0, remove = 0;
          
          for (const p of item.platforms) {
            const existing = existingPlatforms.find(ep => ep.platform_id === p.platform_id);
            if (existing) {
              if (existing.username !== p.username || existing.profile_url !== p.profile_url) {
                update++;
              }
            } else {
              add++;
            }
          }
          
          if (mode === 'replace') {
            remove = existingPlatforms.filter(ep => 
              !item.platforms!.some(p => p.platform_id === ep.platform_id)
            ).length;
          }
          
          if (add > 0 || update > 0 || remove > 0) {
            changes.platforms = { add, update, remove: mode === 'replace' ? remove : undefined };
          }
        }

        // Compute social link changes
        if (item.social_links) {
          const existingLinks = await this.getSocialLinks(existingCreator.id);
          let add = 0, update = 0, remove = 0;
          
          for (const sl of item.social_links) {
            const existing = existingLinks.find(el => el.platform_name === sl.platform_name);
            if (existing) {
              if (existing.url !== sl.url) {
                update++;
              }
            } else {
              add++;
            }
          }
          
          if (mode === 'replace') {
            remove = existingLinks.filter(el => 
              !item.social_links!.some(sl => sl.platform_name === el.platform_name)
            ).length;
          }
          
          if (add > 0 || update > 0 || remove > 0) {
            changes.social_links = { add, update, remove: mode === 'replace' ? remove : undefined };
          }
        }

        // Compute video link changes
        if (item.link_video_ids) {
          const existingVideos = await this.getVideos(existingCreator.id);
          const existingVideoIds = existingVideos.map(v => v.id);
          const add = item.link_video_ids.filter(id => !existingVideoIds.includes(id)).length;
          const remove = mode === 'replace' 
            ? existingVideoIds.filter(id => !item.link_video_ids!.includes(id)).length 
            : undefined;
          
          if (add > 0 || (remove && remove > 0)) {
            changes.videos = { add, remove };
          }
        }
      } else {
        // New creator
        changes.name = { from: null, to: item.name };
        if (item.description) {
          changes.description = { from: null, to: item.description };
        }
        if (item.profile_picture_url) {
          changes.profile_picture = { action: 'set' };
        }
        if (item.platforms && item.platforms.length > 0) {
          changes.platforms = { add: item.platforms.length, update: 0 };
        }
        if (item.social_links && item.social_links.length > 0) {
          changes.social_links = { add: item.social_links.length, update: 0 };
        }
        if (item.link_video_ids && item.link_video_ids.length > 0) {
          changes.videos = { add: item.link_video_ids.length };
        }
      }

      const hasErrors = validationErrors.length > 0 || missingDependencies.length > 0;
      if (hasErrors) errors++;
      else if (action === 'create') willCreate++;
      else willUpdate++;

      previewItems.push({
        index: i,
        action,
        resolved_id: existingCreator?.id ?? null,
        name: item.name,
        validation_errors: validationErrors,
        changes,
        missing_dependencies: missingDependencies,
      });
    }

    // If not dry run and no errors, apply changes
    if (!dryRun && errors === 0) {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const preview = previewItems[i];
        let creatorId: number;

        if (preview.action === 'create') {
          const creator = await this.create({ name: item.name, description: item.description });
          creatorId = creator.id;
          preview.resolved_id = creatorId;
        } else {
          creatorId = preview.resolved_id!;
          if (preview.changes.name || preview.changes.description !== undefined) {
            await this.update(creatorId, { 
              name: preview.changes.name?.to ?? undefined, 
              description: item.description 
            });
          }
        }

        // Set profile picture from URL
        if (item.profile_picture_url) {
          try {
            await this.setPictureFromUrl(creatorId, item.profile_picture_url);
          } catch (error: any) {
            logger.warn({ error, creatorId, url: item.profile_picture_url }, 'Failed to set profile picture from URL');
          }
        }

        // Handle platforms
        if (item.platforms && item.platforms.length > 0) {
          if (mode === 'replace') {
            // Delete existing platforms not in new list
            const existing = await this.getPlatformProfiles(creatorId);
            for (const ep of existing) {
              if (!item.platforms.some(p => p.platform_id === ep.platform_id)) {
                await this.deletePlatformProfile(ep.id);
              }
            }
          }
          await this.bulkUpsertPlatforms(creatorId, item.platforms);
        }

        // Handle social links
        if (item.social_links && item.social_links.length > 0) {
          if (mode === 'replace') {
            // Delete existing links not in new list
            const existing = await this.getSocialLinks(creatorId);
            for (const el of existing) {
              if (!item.social_links.some(sl => sl.platform_name === el.platform_name)) {
                await this.deleteSocialLink(el.id);
              }
            }
          }
          await this.bulkUpsertSocialLinks(creatorId, item.social_links);
        }

        // Handle video links
        if (item.link_video_ids && item.link_video_ids.length > 0) {
          if (mode === 'replace') {
            // Remove existing video links not in new list
            const existingVideos = await this.getVideos(creatorId);
            for (const v of existingVideos) {
              if (!item.link_video_ids.includes(v.id)) {
                await this.removeFromVideo(v.id, creatorId);
              }
            }
          }
          // Add new video links
          for (const videoId of item.link_video_ids) {
            try {
              await this.addToVideo(videoId, creatorId);
            } catch {
              // Ignore duplicates
            }
          }
        }
      }
    }

    return {
      success: errors === 0,
      dry_run: dryRun,
      items: previewItems,
      summary: {
        will_create: willCreate,
        will_update: willUpdate,
        errors,
      },
    };
  }
}

export const creatorsService = new CreatorsService();
