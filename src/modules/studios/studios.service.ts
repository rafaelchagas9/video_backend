import { getDatabase } from '@/config/database';
import { NotFoundError, ConflictError } from '@/utils/errors';
import { env } from '@/config/env';
import { API_PREFIX } from '@/config/constants';
import { logger } from '@/utils/logger';
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import type {
  Studio,
  CreateStudioInput,
  UpdateStudioInput,
  StudioSocialLink,
  CreateStudioSocialLinkInput,
  UpdateStudioSocialLinkInput,
  ListStudiosOptions,
  PaginatedStudios,
  BulkStudioSocialLinkItem,
  BulkOperationResult,
  BulkStudioImportItem,
  BulkStudioImportPreviewItem,
  BulkStudioImportResult
} from './studios.types';
import type { Creator } from '@/modules/creators/creators.types';
import type { Video } from '@/modules/videos/videos.types';

export class StudiosService {
  private get db() {
    return getDatabase();
  }

  // Basic CRUD Operations
  async list(options: ListStudiosOptions = {}): Promise<PaginatedStudios> {
    const {
      page = 1,
      limit = 20,
      search,
      sort = 'name',
      order = 'asc',
      missing,
      complete,
    } = options;

    const offset = (page - 1) * limit;

    // Always need these subqueries for enhanced response
    const socialLinkCountSubquery = `
      LEFT JOIN (
        SELECT studio_id, COUNT(*) as social_link_count 
        FROM studio_social_links 
        GROUP BY studio_id
      ) slc ON s.id = slc.studio_id
    `;
    
    const videoCountSubquery = `
      LEFT JOIN (
        SELECT studio_id, COUNT(*) as video_count 
        FROM video_studios 
        GROUP BY studio_id
      ) vc ON s.id = vc.studio_id
    `;
    
    const creatorCountSubquery = `
      LEFT JOIN (
        SELECT studio_id, COUNT(*) as creator_count 
        FROM creator_studios 
        GROUP BY studio_id
      ) cc ON s.id = cc.studio_id
    `;

    // Build FROM clause with JOINs
    const fromClause = `FROM studios s
      ${socialLinkCountSubquery}
      ${videoCountSubquery}
      ${creatorCountSubquery}`;

    // Build WHERE clause
    const whereClauses: string[] = [];
    const whereParams: any[] = [];

    // Search filter (name)
    if (search) {
      whereClauses.push('s.name LIKE ?');
      whereParams.push(`%${search}%`);
    }

    // Missing filter
    if (missing) {
      switch (missing) {
        case 'picture':
          whereClauses.push('s.profile_picture_path IS NULL');
          break;
        case 'social':
          whereClauses.push('COALESCE(slc.social_link_count, 0) = 0');
          break;
        case 'linked':
          // Missing linked creators AND videos
          whereClauses.push('(COALESCE(vc.video_count, 0) = 0 AND COALESCE(cc.creator_count, 0) = 0)');
          break;
        case 'any':
          // Incomplete: missing picture OR missing social OR missing linked
          whereClauses.push(`(
            s.profile_picture_path IS NULL 
            OR COALESCE(slc.social_link_count, 0) = 0
            OR (COALESCE(vc.video_count, 0) = 0 AND COALESCE(cc.creator_count, 0) = 0)
          )`);
          break;
      }
    }

    // Complete filter
    if (complete !== undefined) {
      // Complete: has picture AND has social AND (has creators OR videos)
      const completenessCondition = `(
        s.profile_picture_path IS NOT NULL 
        AND COALESCE(slc.social_link_count, 0) > 0
        AND (COALESCE(vc.video_count, 0) > 0 OR COALESCE(cc.creator_count, 0) > 0)
      )`;
      
      if (complete) {
        whereClauses.push(completenessCondition);
      } else {
        whereClauses.push(`NOT ${completenessCondition}`);
      }
    }

    const whereClause = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    // Get total count
    const countQuery = `
      SELECT COUNT(*) as count
      ${fromClause}
      ${whereClause}
    `;

    const countResult = this.db.prepare(countQuery).get(...whereParams) as { count: number };
    const total = countResult.count;
    const totalPages = Math.ceil(total / limit);

    // Get studios with sorting and pagination
    const validSortColumns = ['name', 'created_at', 'updated_at', 'video_count', 'creator_count'];
    const sortColumn = validSortColumns.includes(sort) ? sort : 'name';

    // Map sort column to actual column name
    let sortExpression = 's.name';
    if (sortColumn === 'video_count') {
      sortExpression = 'COALESCE(vc.video_count, 0)';
    } else if (sortColumn === 'creator_count') {
      sortExpression = 'COALESCE(cc.creator_count, 0)';
    } else if (sortColumn === 'created_at') {
      sortExpression = 's.created_at';
    } else if (sortColumn === 'updated_at') {
      sortExpression = 's.updated_at';
    }

    const sortOrder = order === 'asc' ? 'ASC' : 'DESC';

    const selectQuery = `
      SELECT 
        s.*,
        COALESCE(slc.social_link_count, 0) as social_link_count,
        COALESCE(vc.video_count, 0) as linked_video_count,
        COALESCE(cc.creator_count, 0) as linked_creator_count
      ${fromClause}
      ${whereClause}
      ORDER BY ${sortExpression} ${sortOrder}
      LIMIT ? OFFSET ?
    `;

    const rawStudios = this.db
      .prepare(selectQuery)
      .all(...whereParams, limit, offset) as any[];

    // Compute completeness for each studio
    const studios = rawStudios.map(studio => {
      const hasPicture = studio.profile_picture_path !== null;
      const hasSocial = studio.social_link_count > 0;
      const hasLinked = studio.linked_video_count > 0 || studio.linked_creator_count > 0;
      
      const missingFields: string[] = [];
      if (!hasPicture) missingFields.push('picture');
      if (!hasSocial) missingFields.push('social');
      if (!hasLinked) missingFields.push('linked');

      return {
        ...studio,
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
        total,
        totalPages,
      },
    };
  }

  async findById(id: number): Promise<Studio> {
    const studio = this.db
      .prepare('SELECT * FROM studios WHERE id = ?')
      .get(id) as Studio | undefined;

    if (!studio) {
      throw new NotFoundError(`Studio not found with id: ${id}`);
    }

    return studio;
  }

  async create(input: CreateStudioInput): Promise<Studio> {
    try {
      const result = this.db
        .prepare('INSERT INTO studios (name, description) VALUES (?, ?)')
        .run(input.name, input.description || null);

      return this.findById(result.lastInsertRowid as number);
    } catch (error: any) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        throw new ConflictError(`Studio with name "${input.name}" already exists`);
      }
      throw error;
    }
  }

  async update(id: number, input: UpdateStudioInput): Promise<Studio> {
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
        .prepare(`UPDATE studios SET ${updates.join(', ')} WHERE id = ?`)
        .run(...values);

      return this.findById(id);
    } catch (error: any) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        throw new ConflictError(`Studio with name "${input.name}" already exists`);
      }
      throw error;
    }
  }

  async delete(id: number): Promise<void> {
    const studio = await this.findById(id); // Ensure exists

    // Delete profile picture file if exists
    if (studio.profile_picture_path) {
      try {
        if (existsSync(studio.profile_picture_path)) {
          unlinkSync(studio.profile_picture_path);
        }
      } catch (error) {
        logger.warn({ error, path: studio.profile_picture_path }, 'Failed to delete studio profile picture file');
        // Continue with database deletion even if file deletion fails
      }
    }

    this.db.prepare('DELETE FROM studios WHERE id = ?').run(id);
  }

  // Profile Picture Methods
  async uploadProfilePicture(id: number, fileBuffer: Buffer, filename: string): Promise<Studio> {
    const studio = await this.findById(id);

    // Ensure directory exists
    if (!existsSync(env.PROFILE_PICTURES_DIR)) {
      mkdirSync(env.PROFILE_PICTURES_DIR, { recursive: true });
    }

    // Delete old picture if exists
    if (studio.profile_picture_path && existsSync(studio.profile_picture_path)) {
      unlinkSync(studio.profile_picture_path);
    }

    // Generate unique filename
    const ext = filename.split('.').pop() || 'jpg';
    const newFilename = `studio_${id}_${Date.now()}.${ext}`;
    const filePath = join(env.PROFILE_PICTURES_DIR, newFilename);

    // Save file
    writeFileSync(filePath, fileBuffer);

    // Update database
    this.db
      .prepare(`UPDATE studios SET profile_picture_path = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(filePath, id);

    return this.findById(id);
  }

  async deleteProfilePicture(id: number): Promise<Studio> {
    const studio = await this.findById(id);

    if (studio.profile_picture_path && existsSync(studio.profile_picture_path)) {
      unlinkSync(studio.profile_picture_path);
    }

    this.db
      .prepare(`UPDATE studios SET profile_picture_path = NULL, updated_at = datetime('now') WHERE id = ?`)
      .run(id);

    return this.findById(id);
  }

  // Social Links Methods
  async addSocialLink(studioId: number, input: CreateStudioSocialLinkInput): Promise<StudioSocialLink> {
    await this.findById(studioId); // Ensure studio exists

    const result = this.db
      .prepare(
        `INSERT INTO studio_social_links (studio_id, platform_name, url)
         VALUES (?, ?, ?)`
      )
      .run(studioId, input.platform_name, input.url);

    return this.findSocialLinkById(result.lastInsertRowid as number);
  }

  async updateSocialLink(id: number, input: UpdateStudioSocialLinkInput): Promise<StudioSocialLink> {
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
      .prepare(`UPDATE studio_social_links SET ${updates.join(', ')} WHERE id = ?`)
      .run(...values);

    return this.findSocialLinkById(id);
  }

  async deleteSocialLink(id: number): Promise<void> {
    await this.findSocialLinkById(id); // Ensure exists
    this.db.prepare('DELETE FROM studio_social_links WHERE id = ?').run(id);
  }

  async getSocialLinks(studioId: number): Promise<StudioSocialLink[]> {
    await this.findById(studioId); // Ensure studio exists

    return this.db
      .prepare(
        `SELECT * FROM studio_social_links
         WHERE studio_id = ?
         ORDER BY platform_name ASC`
      )
      .all(studioId) as StudioSocialLink[];
  }

  private async findSocialLinkById(id: number): Promise<StudioSocialLink> {
    const link = this.db
      .prepare('SELECT * FROM studio_social_links WHERE id = ?')
      .get(id) as StudioSocialLink | undefined;

    if (!link) {
      throw new NotFoundError(`Social link not found with id: ${id}`);
    }

    return link;
  }

  // Creator Relationship Methods
  async linkCreator(studioId: number, creatorId: number): Promise<void> {
    await this.findById(studioId); // Ensure studio exists

    try {
      this.db
        .prepare('INSERT INTO creator_studios (creator_id, studio_id) VALUES (?, ?)')
        .run(creatorId, studioId);
    } catch (error: any) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        throw new ConflictError('Creator is already linked to this studio');
      }
      if (error.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
        throw new NotFoundError(`Creator not found with id: ${creatorId}`);
      }
      throw error;
    }
  }

  async unlinkCreator(studioId: number, creatorId: number): Promise<void> {
    const result = this.db
      .prepare('DELETE FROM creator_studios WHERE creator_id = ? AND studio_id = ?')
      .run(creatorId, studioId);

    if (result.changes === 0) {
      throw new NotFoundError('Creator-studio relationship not found');
    }
  }

  async getCreators(studioId: number): Promise<Creator[]> {
    await this.findById(studioId); // Ensure studio exists

    return this.db
      .prepare(
        `SELECT c.* FROM creators c
         INNER JOIN creator_studios cs ON c.id = cs.creator_id
         WHERE cs.studio_id = ?
         ORDER BY c.name ASC`
      )
      .all(studioId) as Creator[];
  }

  // Video Relationship Methods
  async linkVideo(studioId: number, videoId: number): Promise<void> {
    await this.findById(studioId); // Ensure studio exists

    try {
      this.db
        .prepare('INSERT INTO video_studios (video_id, studio_id) VALUES (?, ?)')
        .run(videoId, studioId);
    } catch (error: any) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        throw new ConflictError('Video is already linked to this studio');
      }
      if (error.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
        throw new NotFoundError(`Video not found with id: ${videoId}`);
      }
      throw error;
    }
  }

  async unlinkVideo(studioId: number, videoId: number): Promise<void> {
    const result = this.db
      .prepare('DELETE FROM video_studios WHERE video_id = ? AND studio_id = ?')
      .run(videoId, studioId);

    if (result.changes === 0) {
      throw new NotFoundError('Video-studio relationship not found');
    }
  }

  async getVideos(studioId: number): Promise<Video[]> {
    await this.findById(studioId); // Ensure studio exists

    const videos = this.db
      .prepare(
        `SELECT v.*, t.id as thumbnail_id
         FROM videos v
         INNER JOIN video_studios vs ON v.id = vs.video_id
         LEFT JOIN thumbnails t ON v.id = t.video_id
         WHERE vs.studio_id = ?
         ORDER BY v.created_at DESC`
      )
      .all(studioId) as Video[];

    return videos.map(v => ({
      ...v,
      thumbnail_url: v.thumbnail_id ? `${API_PREFIX}/thumbnails/${v.thumbnail_id}/image` : null,
    }));
  }

  async getStudiosForVideo(videoId: number): Promise<Studio[]> {
    return this.db
      .prepare(
        `SELECT s.* FROM studios s
         INNER JOIN video_studios vs ON s.id = vs.studio_id
         WHERE vs.video_id = ?
         ORDER BY s.name ASC`
      )
      .all(videoId) as Studio[];
  }

  // Bulk Actions
  async bulkUpdateCreators(studioId: number, input: { creatorIds: number[]; action: 'add' | 'remove' }): Promise<void> {
    const { creatorIds, action } = input;
    if (creatorIds.length === 0) return;

    await this.findById(studioId); // Ensure studio exists

    const update = this.db.transaction(() => {
      if (action === 'add') {
        const insert = this.db.prepare('INSERT OR IGNORE INTO creator_studios (creator_id, studio_id) VALUES (?, ?)');
        for (const creatorId of creatorIds) {
          insert.run(creatorId, studioId);
        }
      } else {
        const deleteStmt = this.db.prepare(
          `DELETE FROM creator_studios WHERE studio_id = ? AND creator_id IN (${creatorIds.map(() => '?').join(',')})`
        );
        deleteStmt.run(studioId, ...creatorIds);
      }
    });

    update();
  }

  async bulkUpsertSocialLinks(studioId: number, items: BulkStudioSocialLinkItem[]): Promise<BulkOperationResult<StudioSocialLink>> {
    await this.findById(studioId); // Ensure studio exists

    const created: StudioSocialLink[] = [];
    const updated: StudioSocialLink[] = [];
    const errors: Array<{ index: number; error: string }> = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      try {
        // Check if exists by platform_name + url
        const existing = this.db
          .prepare(
            `SELECT id FROM studio_social_links 
             WHERE studio_id = ? AND platform_name = ? AND url = ?`
          )
          .get(studioId, item.platform_name, item.url) as { id: number } | undefined;

        if (existing) {
          // Already exists with same data, add to updated
          updated.push(await this.findSocialLinkById(existing.id));
        } else {
          // Check if exists by platform_name only (update url)
          const existingByPlatform = this.db
            .prepare(
              `SELECT id FROM studio_social_links 
               WHERE studio_id = ? AND platform_name = ?`
            )
            .get(studioId, item.platform_name) as { id: number } | undefined;

          if (existingByPlatform) {
            // Update URL
            this.db
              .prepare(`UPDATE studio_social_links SET url = ? WHERE id = ?`)
              .run(item.url, existingByPlatform.id);
            updated.push(await this.findSocialLinkById(existingByPlatform.id));
          } else {
            // Create new
            const result = this.db
              .prepare(
                `INSERT INTO studio_social_links (studio_id, platform_name, url)
                 VALUES (?, ?, ?)`
              )
              .run(studioId, item.platform_name, item.url);
            
            created.push(await this.findSocialLinkById(result.lastInsertRowid as number));
          }
        }
      } catch (error: any) {
        errors.push({ index: i, error: error.message || 'Unknown error' });
      }
    }

    return { created, updated, errors };
  }

  async setPictureFromUrl(studioId: number, url: string): Promise<Studio> {
    const studio = await this.findById(studioId);

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
    if (studio.profile_picture_path && existsSync(studio.profile_picture_path)) {
      unlinkSync(studio.profile_picture_path);
    }

    // Generate unique filename
    const newFilename = `studio_${studioId}_${Date.now()}.${ext}`;
    const filePath = join(env.PROFILE_PICTURES_DIR, newFilename);

    // Save file
    writeFileSync(filePath, buffer);

    // Update database
    this.db
      .prepare(`UPDATE studios SET profile_picture_path = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(filePath, studioId);

    return this.findById(studioId);
  }

  // Bulk Import with Preview
  async bulkImport(items: BulkStudioImportItem[], mode: 'merge' | 'replace', dryRun: boolean): Promise<BulkStudioImportResult> {
    const previewItems: BulkStudioImportPreviewItem[] = [];
    let willCreate = 0;
    let willUpdate = 0;
    let errors = 0;

    // First pass: validate and compute preview
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const validationErrors: string[] = [];
      const missingDependencies: string[] = [];
      let existingStudio: Studio | null = null;
      let action: 'create' | 'update' = 'create';

      // Check if updating existing studio
      if (item.id) {
        try {
          existingStudio = await this.findById(item.id);
          action = 'update';
        } catch {
          validationErrors.push(`Studio with id ${item.id} not found`);
        }
      } else {
        // Check if studio with same name exists
        const existing = this.db
          .prepare('SELECT * FROM studios WHERE name = ?')
          .get(item.name) as Studio | undefined;
        if (existing) {
          existingStudio = existing;
          action = 'update';
        }
      }

      // Validate creator IDs exist
      if (item.link_creator_ids && item.link_creator_ids.length > 0) {
        for (const creatorId of item.link_creator_ids) {
          const creator = this.db.prepare('SELECT id FROM creators WHERE id = ?').get(creatorId);
          if (!creator) {
            missingDependencies.push(`Creator id ${creatorId} not found`);
          }
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

      // Compute changes
      const changes: BulkStudioImportPreviewItem['changes'] = {};

      if (existingStudio) {
        if (existingStudio.name !== item.name) {
          changes.name = { from: existingStudio.name, to: item.name };
        }
        if (item.description !== undefined && existingStudio.description !== (item.description ?? null)) {
          changes.description = { from: existingStudio.description, to: item.description ?? null };
        }
        if (item.profile_picture_url) {
          changes.profile_picture = { action: 'set' };
        }

        // Compute social link changes
        if (item.social_links) {
          const existingLinks = await this.getSocialLinks(existingStudio.id);
          let add = 0, update = 0, remove = 0;
          
          for (const sl of item.social_links) {
            const existing = existingLinks.find(el => el.platform_name === sl.platform_name);
            if (existing) {
              if (existing.url !== sl.url) update++;
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

        // Compute creator link changes
        if (item.link_creator_ids) {
          const existingCreators = await this.getCreators(existingStudio.id);
          const existingCreatorIds = existingCreators.map(c => c.id);
          const add = item.link_creator_ids.filter(id => !existingCreatorIds.includes(id)).length;
          const remove = mode === 'replace' 
            ? existingCreatorIds.filter(id => !item.link_creator_ids!.includes(id)).length 
            : undefined;
          
          if (add > 0 || (remove && remove > 0)) {
            changes.creators = { add, remove };
          }
        }

        // Compute video link changes
        if (item.link_video_ids) {
          const existingVideos = await this.getVideos(existingStudio.id);
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
        // New studio
        changes.name = { from: null, to: item.name };
        if (item.description) {
          changes.description = { from: null, to: item.description };
        }
        if (item.profile_picture_url) {
          changes.profile_picture = { action: 'set' };
        }
        if (item.social_links && item.social_links.length > 0) {
          changes.social_links = { add: item.social_links.length, update: 0 };
        }
        if (item.link_creator_ids && item.link_creator_ids.length > 0) {
          changes.creators = { add: item.link_creator_ids.length };
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
        resolved_id: existingStudio?.id ?? null,
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
        let studioId: number;

        if (preview.action === 'create') {
          const studio = await this.create({ name: item.name, description: item.description });
          studioId = studio.id;
          preview.resolved_id = studioId;
        } else {
          studioId = preview.resolved_id!;
          if (preview.changes.name || preview.changes.description !== undefined) {
            await this.update(studioId, { 
              name: preview.changes.name?.to ?? undefined, 
              description: item.description 
            });
          }
        }

        // Set profile picture from URL
        if (item.profile_picture_url) {
          try {
            await this.setPictureFromUrl(studioId, item.profile_picture_url);
          } catch (error: any) {
            logger.warn({ error, studioId, url: item.profile_picture_url }, 'Failed to set profile picture from URL');
          }
        }

        // Handle social links
        if (item.social_links && item.social_links.length > 0) {
          if (mode === 'replace') {
            const existing = await this.getSocialLinks(studioId);
            for (const el of existing) {
              if (!item.social_links.some(sl => sl.platform_name === el.platform_name)) {
                await this.deleteSocialLink(el.id);
              }
            }
          }
          await this.bulkUpsertSocialLinks(studioId, item.social_links);
        }

        // Handle creator links
        if (item.link_creator_ids && item.link_creator_ids.length > 0) {
          if (mode === 'replace') {
            const existingCreators = await this.getCreators(studioId);
            for (const c of existingCreators) {
              if (!item.link_creator_ids.includes(c.id)) {
                await this.unlinkCreator(studioId, c.id);
              }
            }
          }
          for (const creatorId of item.link_creator_ids) {
            try {
              await this.linkCreator(studioId, creatorId);
            } catch {
              // Ignore duplicates
            }
          }
        }

        // Handle video links
        if (item.link_video_ids && item.link_video_ids.length > 0) {
          if (mode === 'replace') {
            const existingVideos = await this.getVideos(studioId);
            for (const v of existingVideos) {
              if (!item.link_video_ids.includes(v.id)) {
                await this.unlinkVideo(studioId, v.id);
              }
            }
          }
          for (const videoId of item.link_video_ids) {
            try {
              await this.linkVideo(studioId, videoId);
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

export const studiosService = new StudiosService();
