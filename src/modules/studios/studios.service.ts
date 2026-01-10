import { getDatabase } from '@/config/database';
import { NotFoundError, ConflictError } from '@/utils/errors';
import { env } from '@/config/env';
import { API_PREFIX } from '@/config/constants';
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import type {
  Studio,
  CreateStudioInput,
  UpdateStudioInput,
  StudioSocialLink,
  CreateStudioSocialLinkInput,
  UpdateStudioSocialLinkInput
} from './studios.types';
import type { Creator } from '@/modules/creators/creators.types';
import type { Video } from '@/modules/videos/videos.types';

export class StudiosService {
  private get db() {
    return getDatabase();
  }

  // Basic CRUD Operations
  async list(): Promise<Studio[]> {
    return this.db.prepare('SELECT * FROM studios ORDER BY name ASC').all() as Studio[];
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
    await this.findById(id); // Ensure exists
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
}

export const studiosService = new StudiosService();
