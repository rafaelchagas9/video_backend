import { getDatabase } from '@/config/database';
import { NotFoundError, ForbiddenError, ConflictError } from '@/utils/errors';
import type { 
  Playlist, 
  CreatePlaylistInput, 
  UpdatePlaylistInput 
} from './playlists.types';
import { videosService } from '@/modules/videos/videos.service';

export class PlaylistsService {
  private get db() {
    return getDatabase();
  }

  async create(userId: number, input: CreatePlaylistInput): Promise<Playlist> {
    const result = this.db
      .prepare(
        'INSERT INTO playlists (user_id, name, description) VALUES (?, ?, ?)'
      )
      .run(userId, input.name, input.description || null);

    return this.findById(result.lastInsertRowid as number);
  }

  async findById(id: number): Promise<Playlist> {
    const playlist = this.db
      .prepare('SELECT * FROM playlists WHERE id = ?')
      .get(id) as Playlist | undefined;

    if (!playlist) {
      throw new NotFoundError(`Playlist not found with id: ${id}`);
    }

    return playlist;
  }

  async list(userId: number): Promise<Playlist[]> {
    return this.db
      .prepare('SELECT * FROM playlists WHERE user_id = ? ORDER BY created_at DESC')
      .all(userId) as Playlist[];
  }

  async update(id: number, userId: number, input: UpdatePlaylistInput): Promise<Playlist> {
    const playlist = await this.findById(id);

    // Verify ownership
    if (playlist.user_id !== userId) {
      throw new ForbiddenError('You do not have permission to update this playlist');
    }

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
      return playlist;
    }

    updates.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id);

    this.db
      .prepare(`UPDATE playlists SET ${updates.join(', ')} WHERE id = ?`)
      .run(...values);

    return this.findById(id);
  }

  async delete(id: number, userId: number): Promise<void> {
    const playlist = await this.findById(id);

    // Verify ownership
    if (playlist.user_id !== userId) {
      throw new ForbiddenError('You do not have permission to delete this playlist');
    }

    this.db.prepare('DELETE FROM playlists WHERE id = ?').run(id);
  }

  async addVideo(playlistId: number, userId: number, videoId: number, position?: number): Promise<void> {
    const playlist = await this.findById(playlistId);

    // Verify ownership
    if (playlist.user_id !== userId) {
      throw new ForbiddenError('You do not have permission to modify this playlist');
    }

    // Verify video exists
    await videosService.findById(videoId);

    // Check if video already in playlist
    const existing = this.db
      .prepare('SELECT * FROM playlist_videos WHERE playlist_id = ? AND video_id = ?')
      .get(playlistId, videoId);

    if (existing) {
      throw new ConflictError('Video already exists in this playlist');
    }

    // If no position provided, add to end
    let finalPosition = position;
    if (finalPosition === undefined) {
      const maxPos = this.db
        .prepare('SELECT MAX(position) as max_pos FROM playlist_videos WHERE playlist_id = ?')
        .get(playlistId) as { max_pos: number | null };
      
      finalPosition = (maxPos.max_pos ?? -1) + 1;
    }

    this.db
      .prepare('INSERT INTO playlist_videos (playlist_id, video_id, position) VALUES (?, ?, ?)')
      .run(playlistId, videoId, finalPosition);
  }

  async removeVideo(playlistId: number, userId: number, videoId: number): Promise<void> {
    const playlist = await this.findById(playlistId);

    // Verify ownership
    if (playlist.user_id !== userId) {
      throw new ForbiddenError('You do not have permission to modify this playlist');
    }

    const result = this.db
      .prepare('DELETE FROM playlist_videos WHERE playlist_id = ? AND video_id = ?')
      .run(playlistId, videoId);

    if (result.changes === 0) {
      throw new NotFoundError('Video not found in this playlist');
    }
  }

  async getVideos(playlistId: number, userId: number) {
    const playlist = await this.findById(playlistId);

    // Verify ownership
    if (playlist.user_id !== userId) {
      throw new ForbiddenError('You do not have permission to view this playlist');
    }

    return this.db
      .prepare(`
        SELECT v.*, pv.position, pv.added_at as added_to_playlist_at
        FROM videos v
        INNER JOIN playlist_videos pv ON v.id = pv.video_id
        WHERE pv.playlist_id = ?
        ORDER BY pv.position ASC
      `)
      .all(playlistId);
  }

  async reorderVideos(playlistId: number, userId: number, positions: { video_id: number; position: number }[]): Promise<void> {
    const playlist = await this.findById(playlistId);

    // Verify ownership
    if (playlist.user_id !== userId) {
      throw new ForbiddenError('You do not have permission to modify this playlist');
    }

    // Update positions in a transaction-like manner (SQLite auto-commits each statement)
    // For better atomicity, we could use BEGIN/COMMIT, but for simplicity we'll do individual updates
    for (const { video_id, position } of positions) {
      const result = this.db
        .prepare('UPDATE playlist_videos SET position = ? WHERE playlist_id = ? AND video_id = ?')
        .run(position, playlistId, video_id);

      if (result.changes === 0) {
        throw new NotFoundError(`Video ${video_id} not found in playlist`);
      }
    }
  }
}

export const playlistsService = new PlaylistsService();
