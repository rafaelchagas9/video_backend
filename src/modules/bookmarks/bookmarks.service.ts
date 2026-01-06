import { getDatabase } from '@/config/database';
import { NotFoundError, ForbiddenError } from '@/utils/errors';
import type { Bookmark, CreateBookmarkInput, UpdateBookmarkInput } from './bookmarks.types';
import { videosService } from '@/modules/videos/videos.service';

export class BookmarksService {
  private get db() {
    return getDatabase();
  }

  async create(videoId: number, userId: number, input: CreateBookmarkInput): Promise<Bookmark> {
    // Verify video exists
    await videosService.findById(videoId);

    const result = this.db
      .prepare(
        'INSERT INTO bookmarks (video_id, user_id, timestamp_seconds, name, description) VALUES (?, ?, ?, ?, ?)'
      )
      .run(videoId, userId, input.timestamp_seconds, input.name, input.description || null);

    return this.findById(result.lastInsertRowid as number);
  }

  async findById(id: number): Promise<Bookmark> {
    const bookmark = this.db
      .prepare('SELECT * FROM bookmarks WHERE id = ?')
      .get(id) as Bookmark | undefined;

    if (!bookmark) {
      throw new NotFoundError(`Bookmark not found with id: ${id}`);
    }

    return bookmark;
  }

  async getBookmarksForVideo(videoId: number, userId: number): Promise<Bookmark[]> {
    // Verify video exists
    await videosService.findById(videoId);

    return this.db
      .prepare('SELECT * FROM bookmarks WHERE video_id = ? AND user_id = ? ORDER BY timestamp_seconds ASC')
      .all(videoId, userId) as Bookmark[];
  }

  async update(id: number, userId: number, input: UpdateBookmarkInput): Promise<Bookmark> {
    const bookmark = await this.findById(id);

    // Verify ownership
    if (bookmark.user_id !== userId) {
      throw new ForbiddenError('You do not have permission to update this bookmark');
    }

    const updates: string[] = [];
    const values: any[] = [];

    if (input.timestamp_seconds !== undefined) {
      updates.push('timestamp_seconds = ?');
      values.push(input.timestamp_seconds);
    }

    if (input.name !== undefined) {
      updates.push('name = ?');
      values.push(input.name);
    }

    if (input.description !== undefined) {
      updates.push('description = ?');
      values.push(input.description);
    }

    if (updates.length === 0) {
      return bookmark;
    }

    updates.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id);

    this.db
      .prepare(`UPDATE bookmarks SET ${updates.join(', ')} WHERE id = ?`)
      .run(...values);

    return this.findById(id);
  }

  async delete(id: number, userId: number): Promise<void> {
    const bookmark = await this.findById(id);

    // Verify ownership
    if (bookmark.user_id !== userId) {
      throw new ForbiddenError('You do not have permission to delete this bookmark');
    }

    this.db.prepare('DELETE FROM bookmarks WHERE id = ?').run(id);
  }
}

export const bookmarksService = new BookmarksService();
