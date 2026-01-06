import { getDatabase } from '@/config/database';
import { NotFoundError, ConflictError } from '@/utils/errors';
import type { Creator, CreateCreatorInput, UpdateCreatorInput } from './creators.types';
import type { Video } from '@/modules/videos/videos.types';

export class CreatorsService {
  private get db() {
    return getDatabase();
  }

  async list(): Promise<Creator[]> {
    return this.db.prepare('SELECT * FROM creators ORDER BY name ASC').all() as Creator[];
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
}

export const creatorsService = new CreatorsService();
