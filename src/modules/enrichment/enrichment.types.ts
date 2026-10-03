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
export interface FingerprintInput {
  algorithm: "OSHASH" | "PHASH" | "MD5";
  hash: string;
  duration?: number;
}

export interface EnrichRequest {
  scraper_url?: string;
  /** Stash community scraper id for a title search (IAFD, ...). */
  scraper_id?: string;
  fingerprint?: FingerprintInput;
  /** Extra hashes, e.g. the original file's OSHASH from before a conversion. */
  fingerprints?: FingerprintInput[];
  stash_scene_id?: string;
  /** Scenes: fingerprint matches only, never a title search. */
  fingerprint_only?: boolean;
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
  scraper_url?: string;
  scraper_id?: string;
  fingerprint?: FingerprintInput;
  stash_scene_id?: string;
  identify_by_hash?: boolean;
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
  /** Pixel size of an image proposal; null until measured or when unmeasurable. */
  image_width?: number | null;
  image_height?: number | null;
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
  errors: string[] | null;
  started_at: string;
  finished_at: string | null;
}

/** Shape of `raw` on relational candidates (performer / studio / tag / parent / category). */
export interface RelationalRaw {
  external_id?: string | null;
  source?: string | null;
  as?: string | null;
  group?: string | null;
  /** Performers: stash-box gender (FEMALE, MALE, TRANSGENDER_FEMALE, ...). */
  gender?: string | null;
  disambiguation?: string | null;
  /** Performers: older stash-box IDs merged into `external_id`. */
  merged_ids?: string[];
  /** Studios: parent chain, nearest first. */
  parents?: Array<{ name: string; external_id?: string | null }>;
  /** Set when accepting must name a target: "single_name". */
  requires_choice?: string | null;
}

/** How to resolve a performer / studio / tag proposal on accept. */
export interface AcceptChoice {
  /** Link to this existing creator / studio / tag. */
  target_id?: number;
  /** Create a new entity even though one may match by name. */
  create?: boolean;
}

/** One stored performer ID checked against its stash-box. */
export interface PerformerIdentity {
  requested_id: string;
  supported?: boolean;
  found?: boolean;
  id?: string;
  name?: string;
  deleted?: boolean;
  merged?: boolean;
  merged_ids?: string[];
  error?: string;
}

/** What a scene reset undid. */
export interface SceneResetDTO {
  /** Proposals deleted (pending, accepted and rejected), so a rescan starts clean. */
  suggestions_cleared: number;
  /** Fields put back to empty: title, description, release_date, code, director, cover_image_url. */
  fields_cleared: string[];
  /** Cast, studio, tag and source-id links removed. */
  links_removed: number;
}
