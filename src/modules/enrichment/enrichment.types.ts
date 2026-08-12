/**
 * Types for the enrichment module and its client to the Python service.
 */

export type EntityType = "creator" | "studio" | "scene" | "tag";

export type CandidateType =
  | "image"
  | "platform"
  | "social"
  | "bio"
  | "alias"
  | "field"
  | "external_id"
  // Relational / taxonomy candidates (studio / scene / tag enrichment).
  | "performer"
  | "studio"
  | "tag"
  | "category"
  | "parent";

/** A normalized candidate as returned by the Python enrichment service. */
export interface Candidate {
  type: CandidateType;
  value: string;
  source: string;
  source_url?: string | null;
  /** For `field` candidates, the target column (e.g. "gender", "title"). */
  field_key?: string | null;
  confidence?: number | null;
  /** Relational candidates carry { external_id, source, as? } here. */
  raw?: unknown;
}

/** Discovery input sent to the Python service. */
export interface EnrichRequest {
  name: string;
  entity_type: EntityType;
  aliases: string[];
  handles: string[];
  /** Exact external IDs to fetch, scoped by source. */
  external_ids?: Array<{ source: string; external_id: string }>;
  /** Scene (video) matching hints. */
  title?: string | null;
  file_name?: string | null;
  duration_seconds?: number | null;
  sources?: string[];
  limit?: number;
}

/** Aggregated discovery result from the Python service. */
export interface EnrichResponse {
  candidates: Candidate[];
  sources_used: string[];
  errors: string[];
}

export interface EnrichmentHealthResponse {
  status: string;
  version?: string;
  sources?: string[];
}

export interface RunEnrichmentOptions {
  sources?: string[];
  search_name?: string;
  limit?: number;
  /** StashDB/ThePornDB entity URL or a raw ID scoped by `sources`. */
  external_ref?: string;
}

/** snake_case DTO for a stored suggestion (API response shape). */
export interface SuggestionDTO {
  id: number;
  entity_type: string;
  entity_id: number;
  type: string;
  field_key: string | null;
  value: string;
  source: string;
  source_url: string | null;
  confidence: number | null;
  face_match_score: number | null;
  cached_preview_path: string | null;
  status: string;
  dedup_hash: string;
  raw: unknown;
  created_at: string;
  updated_at: string;
}

/** snake_case DTO for an enrichment run (API response shape). */
export interface RunDTO {
  id: number;
  entity_type: string;
  entity_id: number;
  status: string;
  sources_used: unknown;
  suggestion_count: number;
  errors: unknown;
  started_at: string;
  finished_at: string | null;
}

/** Shape of `raw` on relational candidates (performer / studio / tag / parent / category). */
export interface RelationalRaw {
  external_id?: string | null;
  source?: string | null;
  as?: string | null;
  group?: string | null;
}
