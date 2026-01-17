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

export interface TriageStatistics {
  total_untagged_videos: number;
  total_videos: number;
  tagged_percentage: number;
  recent_progress: {
    last_24h_processed: number;
    last_7d_processed: number;
    avg_daily_rate: number;
  };
  filter_breakdown: Array<{
    filter_key: string;
    total: number;
    processed_count: number;
    percentage: number;
  }>;
  top_directories: Array<{
    directory_id: number;
    path: string;
    untagged_count: number;
  }>;
}

export interface TriageBulkActionsInput {
  videoIds: number[];
  actions: {
    addCreatorIds?: number[];
    removeCreatorIds?: number[];
    addTagIds?: number[];
    removeTagIds?: number[];
    addStudioIds?: number[];
    removeStudioIds?: number[];
    markTagged?: boolean;
  };
}

export interface TriageBulkActionsResult {
  success: boolean;
  processed: number;
  errors: number;
  details: {
    creators_added: number;
    creators_removed: number;
    tags_added: number;
    tags_removed: number;
    studios_added: number;
    studios_removed: number;
  };
}
