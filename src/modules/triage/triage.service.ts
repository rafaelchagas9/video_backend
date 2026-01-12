import { getDatabase } from '@/config/database';
import type { TriageProgress, SaveTriageProgressInput, GetTriageProgressInput } from './triage.types';

export class TriageService {
  private get db() {
    return getDatabase();
  }

  async saveProgress(userId: number, input: SaveTriageProgressInput): Promise<void> {
    const { filterKey, lastVideoId, processedCount, totalCount } = input;

    this.db.prepare(`
      INSERT INTO triage_progress (user_id, filter_key, last_video_id, processed_count, total_count)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, filter_key) DO UPDATE SET
        last_video_id = excluded.last_video_id,
        processed_count = excluded.processed_count,
        total_count = COALESCE(excluded.total_count, total_count),
        updated_at = datetime('now')
    `).run(userId, filterKey, lastVideoId, processedCount, totalCount ?? null);
  }

  async getProgress(userId: number, input: GetTriageProgressInput): Promise<TriageProgress | null> {
    const { filterKey } = input;

    const progress = this.db.prepare(`
      SELECT * FROM triage_progress
      WHERE user_id = ? AND filter_key = ?
    `).get(userId, filterKey) as TriageProgress | undefined;

    return progress ?? null;
  }

  async deleteProgress(userId: number, filterKey: string): Promise<void> {
    this.db.prepare(`
      DELETE FROM triage_progress
      WHERE user_id = ? AND filter_key = ?
    `).run(userId, filterKey);
  }

  async listProgress(userId: number): Promise<TriageProgress[]> {
    return this.db.prepare(`
      SELECT * FROM triage_progress
      WHERE user_id = ?
      ORDER BY updated_at DESC
    `).all(userId) as TriageProgress[];
  }
}

export const triageService = new TriageService();
