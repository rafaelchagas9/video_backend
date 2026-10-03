import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/config/drizzle";
import {
  tagVisualQueriesTable,
  videoFrameEmbeddingsTable,
  videoVisualIndexTable,
} from "@/database/schema";
import { halfToFloat } from "./visual-search.vectors";

export interface FrameHit {
  videoId: number;
  frameIndex: number;
  timestampSeconds: number;
  similarity: number;
}

export interface IndexedVideo {
  videoId: number;
  modelRevision: string;
  storyboardGeneratedAt: Date;
  intervalSeconds: number;
  frameCount: number;
}

export interface FrameRow {
  frameIndex: number;
  timestampSeconds: number;
  /** fp16 bits, `dimension` values. */
  vector: Uint16Array;
}

export interface FrameSearchOptions {
  limit: number;
  /** Restrict to these videos (exact scan). */
  videoIds?: number[];
  excludeVideoIds?: number[];
}

export interface TagVisualQuery {
  id: number;
  tagId: number;
  query: string;
  createdAt: Date;
}

export interface VisualSearchStore {
  searchFrames(vector: Float32Array, options: FrameSearchOptions): Promise<FrameHit[]>;
  /** The stored embedding of the frame nearest a timestamp, for "more like this moment". */
  frameVector(videoId: number, timestampSeconds: number): Promise<Float32Array | null>;
  /** Every frame of one video in time order (for per-video analysis). */
  videoFrames(videoId: number): Promise<{ timestamps: number[]; vectors: Float32Array[] }>;
  indexed(videoIds: number[]): Promise<Map<number, IndexedVideo>>;
  indexedCount(): Promise<{ videos: number; frames: number }>;
  replaceVideo(meta: IndexedVideo, frames: FrameRow[]): Promise<void>;
  tagQueries(tagId: number): Promise<TagVisualQuery[]>;
  addTagQuery(tagId: number, query: string): Promise<TagVisualQuery>;
  removeTagQuery(tagId: number, id: number): Promise<boolean>;
}

/** Exact scans beat HNSW + post-filtering once a filter narrows the candidates this far. */
const EXACT_SCAN_MAX_VIDEOS = 400;

function literal(vector: Float32Array): string {
  let out = "[";
  for (let i = 0; i < vector.length; i++) {
    if (i) out += ",";
    out += vector[i]!.toPrecision(6);
  }
  return out + "]";
}

function halfLiteral(bits: Uint16Array): string {
  let out = "[";
  for (let i = 0; i < bits.length; i++) {
    if (i) out += ",";
    out += halfToFloat(bits[i]!).toPrecision(5);
  }
  return out + "]";
}

function parseVector(text: string): Float32Array {
  return Float32Array.from(text.slice(1, -1).split(",").map(Number));
}

export class PostgresVisualSearchStore implements VisualSearchStore {
  async searchFrames(vector: Float32Array, options: FrameSearchOptions): Promise<FrameHit[]> {
    const q = literal(vector);
    const exclude = options.excludeVideoIds?.length
      ? sql`AND video_id <> ALL(${`{${options.excludeVideoIds.join(",")}}`}::int[])`
      : sql``;
    if (options.videoIds) {
      if (!options.videoIds.length) return [];
      if (options.videoIds.length <= EXACT_SCAN_MAX_VIDEOS) {
        const rows = await db.execute<{
          video_id: number;
          frame_index: number;
          timestamp_seconds: number;
          distance: number;
        }>(sql`
          WITH scored AS MATERIALIZED (
            SELECT video_id, frame_index, timestamp_seconds,
                   embedding <=> ${q}::halfvec AS distance
            FROM video_frame_embeddings
            WHERE video_id = ANY(${`{${options.videoIds.join(",")}}`}::int[]) ${exclude}
          )
          SELECT * FROM scored ORDER BY distance LIMIT ${options.limit}`);
        return rows.map(toHit);
      }
    }
    const only = options.videoIds
      ? sql`AND video_id = ANY(${`{${options.videoIds.join(",")}}`}::int[])`
      : sql``;
    return db.transaction(async (tx) => {
      // Iterative scans keep walking the graph when filters discard candidates (pgvector 0.8).
      await tx.execute(sql`SET LOCAL hnsw.ef_search = 400`);
      await tx.execute(sql`SET LOCAL hnsw.iterative_scan = relaxed_order`);
      await tx.execute(sql`SET LOCAL hnsw.max_scan_tuples = 60000`);
      const rows = await tx.execute<{
        video_id: number;
        frame_index: number;
        timestamp_seconds: number;
        distance: number;
      }>(sql`
        SELECT video_id, frame_index, timestamp_seconds,
               embedding <=> ${q}::halfvec AS distance
        FROM video_frame_embeddings
        WHERE true ${only} ${exclude}
        ORDER BY embedding <=> ${q}::halfvec
        LIMIT ${options.limit}`);
      return rows.map(toHit).sort((a, b) => b.similarity - a.similarity);
    });
  }

  async frameVector(videoId: number, timestampSeconds: number) {
    const rows = await db.execute<{ embedding: string }>(sql`
      SELECT embedding::text AS embedding FROM video_frame_embeddings
      WHERE video_id = ${videoId}
      ORDER BY abs(timestamp_seconds - ${timestampSeconds}) LIMIT 1`);
    return rows[0] ? parseVector(rows[0].embedding) : null;
  }

  async videoFrames(videoId: number) {
    const rows = await db.execute<{ timestamp_seconds: number; embedding: string }>(sql`
      SELECT timestamp_seconds, embedding::text AS embedding FROM video_frame_embeddings
      WHERE video_id = ${videoId} ORDER BY frame_index`);
    return {
      timestamps: rows.map((row) => Number(row.timestamp_seconds)),
      vectors: rows.map((row) => parseVector(row.embedding)),
    };
  }

  async indexed(videoIds: number[]) {
    if (!videoIds.length) return new Map<number, IndexedVideo>();
    const rows = await db
      .select()
      .from(videoVisualIndexTable)
      .where(inArray(videoVisualIndexTable.videoId, videoIds));
    return new Map(rows.map((row) => [row.videoId, row]));
  }

  async indexedCount() {
    const [row] = await db.execute<{ videos: number; frames: number }>(sql`
      SELECT count(*)::int AS videos, coalesce(sum(frame_count), 0)::int AS frames
      FROM video_visual_index`);
    return { videos: row?.videos ?? 0, frames: row?.frames ?? 0 };
  }

  async replaceVideo(meta: IndexedVideo, frames: FrameRow[]) {
    await db.transaction(async (tx) => {
      await tx
        .delete(videoFrameEmbeddingsTable)
        .where(eq(videoFrameEmbeddingsTable.videoId, meta.videoId));
      for (let offset = 0; offset < frames.length; offset += 100) {
        const chunk = frames.slice(offset, offset + 100);
        await tx.execute(sql`
          INSERT INTO video_frame_embeddings (video_id, frame_index, timestamp_seconds, embedding)
          VALUES ${sql.join(
            chunk.map(
              (frame) =>
                sql`(${meta.videoId}, ${frame.frameIndex}, ${frame.timestampSeconds}, ${halfLiteral(frame.vector)}::halfvec)`
            ),
            sql`, `
          )}`);
      }
      await tx
        .insert(videoVisualIndexTable)
        .values({ ...meta, indexedAt: new Date() })
        .onConflictDoUpdate({
          target: videoVisualIndexTable.videoId,
          set: {
            modelRevision: meta.modelRevision,
            storyboardGeneratedAt: meta.storyboardGeneratedAt,
            intervalSeconds: meta.intervalSeconds,
            frameCount: meta.frameCount,
            indexedAt: new Date(),
          },
        });
    });
  }

  async tagQueries(tagId: number) {
    return db
      .select()
      .from(tagVisualQueriesTable)
      .where(eq(tagVisualQueriesTable.tagId, tagId))
      .orderBy(tagVisualQueriesTable.createdAt);
  }

  async addTagQuery(tagId: number, query: string) {
    const [row] = await db
      .insert(tagVisualQueriesTable)
      .values({ tagId, query })
      .onConflictDoUpdate({
        target: [tagVisualQueriesTable.tagId, tagVisualQueriesTable.query],
        set: { query },
      })
      .returning();
    return row!;
  }

  async removeTagQuery(tagId: number, id: number) {
    const rows = await db
      .delete(tagVisualQueriesTable)
      .where(and(eq(tagVisualQueriesTable.tagId, tagId), eq(tagVisualQueriesTable.id, id)))
      .returning({ id: tagVisualQueriesTable.id });
    return rows.length > 0;
  }
}

function toHit(row: {
  video_id: number;
  frame_index: number;
  timestamp_seconds: number;
  distance: number;
}): FrameHit {
  return {
    videoId: Number(row.video_id),
    frameIndex: Number(row.frame_index),
    timestampSeconds: Number(row.timestamp_seconds),
    similarity: 1 - Number(row.distance),
  };
}
