import { getDatabase } from '@/config/database';
import { NotFoundError } from '@/utils/errors';
import type { Rating, CreateRatingInput, UpdateRatingInput } from './ratings.types';
import { videosService } from '@/modules/videos/videos.service';

export class RatingsService {
  private get db() {
    return getDatabase();
  }

  async addRating(videoId: number, input: CreateRatingInput): Promise<Rating> {
    await videosService.findById(videoId); // Ensure video exists

    const result = this.db
      .prepare(
        'INSERT INTO ratings (video_id, rating, comment) VALUES (?, ?, ?)'
      )
      .run(videoId, input.rating, input.comment || null);

    return this.findById(result.lastInsertRowid as number);
  }

  async findById(id: number): Promise<Rating> {
    const rating = this.db
      .prepare('SELECT * FROM ratings WHERE id = ?')
      .get(id) as Rating | undefined;

    if (!rating) {
      throw new NotFoundError(`Rating not found with id: ${id}`);
    }

    return rating;
  }

  async getRatingsForVideo(videoId: number): Promise<Rating[]> {
    await videosService.findById(videoId); // Ensure video exists

    return this.db
      .prepare('SELECT * FROM ratings WHERE video_id = ? ORDER BY rated_at DESC')
      .all(videoId) as Rating[];
  }

  async update(id: number, input: UpdateRatingInput): Promise<Rating> {
    await this.findById(id); // Ensure exists

    const updates: string[] = [];
    const values: any[] = [];

    if (input.rating !== undefined) {
      updates.push('rating = ?');
      values.push(input.rating);
    }

    if (input.comment !== undefined) {
      updates.push('comment = ?');
      values.push(input.comment);
    }

    if (updates.length === 0) {
      return this.findById(id);
    }

    // SQLite doesn't have an updated_at column for ratings in the schema provided, 
    // but the task descriptions imply standard CRUD. 
    // The schema only has rated_at (created_at equivalent).
    // I will simply update the fields.
    
    values.push(id);

    this.db
      .prepare(`UPDATE ratings SET ${updates.join(', ')} WHERE id = ?`)
      .run(...values);

    return this.findById(id);
  }

  async delete(id: number): Promise<void> {
    await this.findById(id); // Ensure exists
    this.db.prepare('DELETE FROM ratings WHERE id = ?').run(id);
  }

  async getAverageRating(videoId: number): Promise<number | null> {
    const result = this.db
      .prepare('SELECT AVG(rating) as avg_rating FROM ratings WHERE video_id = ?')
      .get(videoId) as { avg_rating: number | null };

    return result.avg_rating;
  }
}

export const ratingsService = new RatingsService();
