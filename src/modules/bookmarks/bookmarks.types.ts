export type BookmarkOrigin = "manual" | "automatic";
export type BookmarkCategoryKind = "system" | "custom";

export interface BookmarkCategory {
  id: number;
  key: string;
  name: string;
  kind: BookmarkCategoryKind;
  user_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface BookmarkCategoryAssignment {
  id: number;
  key: string;
  name: string;
  kind: BookmarkCategoryKind;
  confidence: number | null;
  provider_label: string | null;
}

export interface Bookmark {
  id: number;
  video_id: number;
  user_id: number;
  timestamp_seconds: number;
  end_timestamp_seconds: number | null;
  peak_timestamp_seconds: number | null;
  origin: BookmarkOrigin;
  analysis_run_id: number | null;
  user_modified_at: string | null;
  is_user_edited: boolean;
  name: string;
  description: string | null;
  categories: BookmarkCategoryAssignment[];
  created_at: string;
  updated_at: string;
}

export interface CreateBookmarkInput {
  timestamp_seconds: number;
  end_timestamp_seconds?: number;
  peak_timestamp_seconds?: number;
  name: string;
  description?: string;
  category_ids?: number[];
}

export interface UpdateBookmarkInput {
  timestamp_seconds?: number;
  end_timestamp_seconds?: number | null;
  peak_timestamp_seconds?: number | null;
  name?: string;
  description?: string | null;
  category_ids?: number[];
}

export interface BookmarkListFilters {
  origin?: BookmarkOrigin | "all";
  category?: string;
}

export interface CreateBookmarkCategoryInput {
  key: string;
  name: string;
}

export interface UpdateBookmarkCategoryInput {
  name: string;
}
