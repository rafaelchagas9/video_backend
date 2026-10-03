import { basename } from "node:path";
import { env } from "@/config/env";
import { NotFoundError } from "@/utils/errors";
import { videosSearchService } from "@/modules/videos/videos.search.service";
import type { ListVideosOptions } from "@/modules/videos/videos.types";
import { visualSearchClient, VisualSearchUnavailableError } from "./visual-search.client";
import { DemoVisualSearchStore } from "./visual-search.demo.store";
import {
  PostgresVisualSearchStore,
  type FrameHit,
  type VisualSearchStore,
} from "./visual-search.store";
import { normalize } from "./visual-search.vectors";

export interface VisualSearchFilters {
  creatorIds?: number[];
  tagIds?: number[];
  studioIds?: number[];
  /** Leave out videos carrying any of these tags (e.g. the tag being curated). */
  excludeTagIds?: number[];
  untagged?: boolean;
  unwatched?: boolean;
}

export interface VisualMoment {
  start_seconds: number;
  end_seconds: number;
  peak_seconds: number;
  score: number;
}

export interface VisualVideoResult {
  video_id: number;
  score: number;
  hits: number;
  moments: VisualMoment[];
}

export interface VisualSearchResponse {
  results: VisualVideoResult[];
  /** Best frame similarity in the result set; clients scale relevance against it. */
  top_score: number;
  searched_videos: number | null;
  took_ms: number;
}

/** Frames pulled from the index per query before grouping into videos and moments. */
const FRAME_POOL = 1500;
/** Hits closer than this merge into one moment. Storyboard tiles are ~5 s apart. */
const MOMENT_GAP_SECONDS = 20;
const MAX_MOMENTS_PER_VIDEO = 6;

let store: VisualSearchStore | null = null;
export function visualSearchStore(): VisualSearchStore {
  if (store) return store;
  store = env.DEMO_MODE
    ? new DemoVisualSearchStore(() => demoVideoIdsByFileName())
    : new PostgresVisualSearchStore();
  return store;
}

async function demoVideoIdsByFileName(): Promise<Map<string, number[]>> {
  const { demoRepository } = await import("@/database/demo/repository");
  const page = demoRepository.getVideos({ limit: 10_000, page: 1 }) as {
    data: { id: number; file_path: string }[];
  };
  const ids = new Map<string, number[]>();
  for (const video of page.data) {
    const key = basename(video.file_path);
    ids.set(key, [...(ids.get(key) ?? []), video.id]);
  }
  return ids;
}

/** Group frame hits into per-video moments: runs of nearby matching frames. */
export function groupMoments(hits: FrameHit[], limit: number): VisualVideoResult[] {
  const byVideo = new Map<number, FrameHit[]>();
  for (const hit of hits) {
    const list = byVideo.get(hit.videoId) ?? [];
    list.push(hit);
    byVideo.set(hit.videoId, list);
  }
  const results: VisualVideoResult[] = [];
  for (const [videoId, list] of byVideo) {
    list.sort((a, b) => a.timestampSeconds - b.timestampSeconds);
    const moments: (VisualMoment & { frames: number })[] = [];
    let current: (VisualMoment & { frames: number }) | null = null;
    for (const hit of list) {
      if (current && hit.timestampSeconds - current.end_seconds <= MOMENT_GAP_SECONDS) {
        current.end_seconds = hit.timestampSeconds;
        current.frames++;
        if (hit.similarity > current.score) {
          current.score = hit.similarity;
          current.peak_seconds = hit.timestampSeconds;
        }
        continue;
      }
      current = {
        start_seconds: hit.timestampSeconds,
        end_seconds: hit.timestampSeconds,
        peak_seconds: hit.timestampSeconds,
        score: hit.similarity,
        frames: 1,
      };
      moments.push(current);
    }
    moments.sort((a, b) => b.score - a.score);
    results.push({
      video_id: videoId,
      score: moments[0]!.score,
      hits: list.length,
      moments: moments.slice(0, MAX_MOMENTS_PER_VIDEO).map(({ frames: _frames, ...moment }) => ({
        ...moment,
        start_seconds: round(moment.start_seconds),
        end_seconds: round(moment.end_seconds),
        peak_seconds: round(moment.peak_seconds),
        score: round(moment.score, 4),
      })),
    });
  }
  return results
    .sort((a, b) => b.score - a.score || b.hits - a.hits)
    .slice(0, limit)
    .map((result) => ({ ...result, score: round(result.score, 4) }));
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

async function videoIds(userId: number, options: ListVideosOptions): Promise<number[]> {
  const ids: number[] = [];
  for (let page = 1; ; page++) {
    const result = await videosSearchService.list(userId, { ...options, page, limit: 1000 });
    ids.push(...result.data.map((video) => video.id));
    if (page >= result.pagination.totalPages || !result.data.length) break;
  }
  return ids;
}

class TextVectorCache {
  private readonly entries = new Map<string, Float32Array>();
  constructor(private readonly capacity: number) {}
  get(key: string) {
    const value = this.entries.get(key);
    if (value) {
      this.entries.delete(key);
      this.entries.set(key, value);
    }
    return value;
  }
  set(key: string, value: Float32Array) {
    this.entries.set(key, value);
    if (this.entries.size > this.capacity)
      this.entries.delete(this.entries.keys().next().value!);
  }
}

export class VisualSearchService {
  private readonly textCache = new TextVectorCache(256);

  constructor(private readonly storeFactory: () => VisualSearchStore = visualSearchStore) {}

  private get store() {
    return this.storeFactory();
  }

  async status() {
    const [service, counts] = await Promise.all([
      visualSearchClient.status(),
      this.store.indexedCount(),
    ]);
    return {
      ready: service.ready,
      state: service.state,
      model_revision: service.modelRevision,
      indexed_videos: counts.videos,
      indexed_frames: counts.frames,
    };
  }

  async textVector(query: string): Promise<Float32Array> {
    const key = query.trim().toLowerCase();
    const cached = this.textCache.get(key);
    if (cached) return cached;
    const { vectors } = await visualSearchClient.embedText([key]);
    const vector = vectors[0]!;
    this.textCache.set(key, vector);
    return vector;
  }

  /** Resolve relationship filters into candidate / excluded video id sets. */
  private async scope(userId: number, filters: VisualSearchFilters) {
    const listFilters: ListVideosOptions = {};
    if (filters.creatorIds?.length) listFilters.creatorIds = filters.creatorIds;
    if (filters.tagIds?.length) listFilters.tagIds = filters.tagIds;
    if (filters.studioIds?.length) listFilters.studioIds = filters.studioIds;
    if (filters.untagged) listFilters.hasTags = false;
    if (filters.unwatched) listFilters.isWatched = false;
    const restricted = Object.keys(listFilters).length > 0;
    const [only, excluded] = await Promise.all([
      restricted ? videoIds(userId, listFilters) : Promise.resolve(undefined),
      filters.excludeTagIds?.length
        ? videoIds(userId, { tagIds: filters.excludeTagIds })
        : Promise.resolve([]),
    ]);
    return { only, excluded };
  }

  async searchVector(
    userId: number,
    vectors: Float32Array[],
    filters: VisualSearchFilters,
    limit: number,
    extraExcluded: number[] = []
  ): Promise<VisualSearchResponse> {
    const started = performance.now();
    const { only, excluded } = await this.scope(userId, filters);
    const pools = await Promise.all(
      vectors.map((vector) =>
        this.store.searchFrames(vector, {
          limit: FRAME_POOL,
          videoIds: only,
          excludeVideoIds: [...excluded, ...extraExcluded],
        })
      )
    );
    // Several queries (a tag's saved descriptions) merge by best similarity per frame.
    const merged = new Map<string, FrameHit>();
    for (const pool of pools)
      for (const hit of pool) {
        const key = `${hit.videoId}:${hit.frameIndex}`;
        const previous = merged.get(key);
        if (!previous || hit.similarity > previous.similarity) merged.set(key, hit);
      }
    const hits = [...merged.values()].sort((a, b) => b.similarity - a.similarity).slice(0, FRAME_POOL);
    const results = groupMoments(hits, limit);
    return {
      results,
      top_score: results[0]?.score ?? 0,
      searched_videos: only ? only.length : null,
      took_ms: Math.round(performance.now() - started),
    };
  }

  async search(
    userId: number,
    input: { query: string; filters: VisualSearchFilters; limit: number }
  ): Promise<VisualSearchResponse> {
    const vector = await this.textVector(input.query);
    return this.searchVector(userId, [vector], input.filters, input.limit);
  }

  /** "More like this moment": the frame at a timestamp becomes the query. */
  async similar(
    userId: number,
    input: {
      videoId: number;
      timestampSeconds: number;
      includeSameVideo: boolean;
      filters: VisualSearchFilters;
      limit: number;
    }
  ): Promise<VisualSearchResponse> {
    const vector = await this.store.frameVector(input.videoId, input.timestampSeconds);
    if (!vector) throw new NotFoundError("This video is not in the visual index yet");
    return this.searchVector(
      userId,
      [normalize(vector)],
      input.filters,
      input.limit,
      input.includeSameVideo ? [] : [input.videoId]
    );
  }

  async tagQueries(tagId: number) {
    return (await this.store.tagQueries(tagId)).map(toQueryDto);
  }

  async addTagQuery(tagId: number, query: string) {
    return toQueryDto(await this.store.addTagQuery(tagId, query.trim()));
  }

  async removeTagQuery(tagId: number, id: number) {
    if (!(await this.store.removeTagQuery(tagId, id)))
      throw new NotFoundError("Visual query not found");
  }

  /** Untagged-by-this-tag videos that look like the tag's saved descriptions. */
  async tagSuggestions(userId: number, tagId: number, limit: number) {
    const queries = await this.store.tagQueries(tagId);
    if (!queries.length) return { queries: [], ...emptyResponse() };
    const vectors = await Promise.all(queries.map((row) => this.textVector(row.query)));
    const response = await this.searchVector(
      userId,
      vectors,
      { excludeTagIds: [tagId] },
      limit
    );
    return { queries: queries.map(toQueryDto), ...response };
  }
}

function emptyResponse(): VisualSearchResponse {
  return { results: [], top_score: 0, searched_videos: null, took_ms: 0 };
}

function toQueryDto(row: { id: number; tagId: number; query: string; createdAt: Date }) {
  return { id: row.id, tag_id: row.tagId, query: row.query, created_at: row.createdAt.toISOString() };
}

export { VisualSearchUnavailableError };
export const visualSearchService = new VisualSearchService();
