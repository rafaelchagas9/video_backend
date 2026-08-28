export type CleanupDisposition = "unreviewed" | "keep" | "delete" | "later";

export interface CleanupCandidate {
  id: number;
  title: string | null;
  file_name: string;
  file_size_bytes: number;
  duration_seconds: number | null;
  indexed_at: string;
  codec: string | null;
  bitrate: number | null;
  thumbnail_url: string | null;
  creators: Array<{ id: number; name: string }>;
  engagement: {
    play_count: number;
    total_watch_seconds: number;
    watched_fraction: number;
    last_watched_at: string | null;
  };
  protections: {
    favorite: boolean;
    favorited_creator: boolean;
    high_rating: boolean;
    bookmark: boolean;
    playlist: boolean;
    collection: boolean;
    active_job: boolean;
  };
  reasons: string[];
  eligible: boolean;
  disposition: CleanupDisposition;
  revision: number;
  reviewed_at: string | null;
}

export interface CleanupOverview {
  policy: {
    min_age_days: number;
    max_watch_seconds: number;
    max_watch_fraction: number;
  };
  library: { count: number; bytes: number };
  quick_wins: {
    count: number;
    bytes: number;
    unreviewed_count: number;
    unreviewed_bytes: number;
  };
  decisions: Record<
    "keep" | "delete" | "later",
    { count: number; bytes: number }
  >;
  rewards: {
    reviewed_count: number;
    reviewed_bytes: number;
    today_count: number;
    daily_goal: number;
    streak_days: number;
    activity: Array<{ date: string; count: number; bytes: number }>;
  };
}
