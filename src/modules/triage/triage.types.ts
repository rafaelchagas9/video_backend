export interface TriageProgress {
  id: number;
  user_id: number;
  filter_key: string;
  last_video_id: number | null;
  processed_count: number;
  total_count: number | null;
  created_at: string;
  updated_at: string;
}

export interface SaveTriageProgressInput {
  filterKey: string;
  lastVideoId: number;
  processedCount: number;
  totalCount?: number;
}

export interface GetTriageProgressInput {
  filterKey: string;
}
