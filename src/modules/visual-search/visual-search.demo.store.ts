import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { env } from "@/config/env";
import { dot, halvesToFloats } from "./visual-search.vectors";
import type {
  FrameHit,
  FrameRow,
  FrameSearchOptions,
  IndexedVideo,
  TagVisualQuery,
  VisualSearchStore,
} from "./visual-search.store";

/**
 * Demo vectors live in files next to the other pre-rendered demo assets
 * (`bun scripts/generate-demo-visual-index.ts`), keyed by source file name so a
 * re-seeded demo database keeps them. Brute force is instant at demo scale.
 */
interface DemoEntry {
  fileName: string;
  modelRevision: string;
  storyboardGeneratedAt: string;
  intervalSeconds: number;
  timestamps: number[];
  offset: number;
}

interface DemoManifest {
  version: 1;
  dimension: number;
  entries: DemoEntry[];
}

export function demoVisualDir(): string {
  return resolve(process.cwd(), env.DEMO_ASSETS_DIR, "visual");
}

interface LoadedVideo {
  meta: IndexedVideo;
  timestamps: number[];
  vectors: Float32Array[];
}

export class DemoVisualSearchStore implements VisualSearchStore {
  private videos = new Map<number, LoadedVideo>();
  private queries: TagVisualQuery[] = [];
  private nextQueryId = 1;
  private loading: Promise<void> | null = null;
  private dimension = 0;

  /**
   * Resolves file names to demo video ids (catalog rows share source files); injected so
   * tests need no demo database.
   */
  constructor(private readonly videoIdsByFileName: () => Promise<Map<string, number[]>>) {}

  private loadedVersion = -1;

  /** Re-reads the files when the generator rewrites them, so no restart is needed. */
  private load(): Promise<void> {
    const manifestPath = resolve(demoVisualDir(), "index.json");
    const version = existsSync(manifestPath) ? statSync(manifestPath).mtimeMs : 0;
    if (version !== this.loadedVersion) {
      this.loadedVersion = version;
      this.loading = this.read();
    }
    return this.loading!;
  }

  private async read() {
    this.videos = new Map();
    const dir = demoVisualDir();
    const manifestPath = resolve(dir, "index.json");
    if (!existsSync(manifestPath)) return;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as DemoManifest;
    const raw = readFileSync(resolve(dir, "vectors.f16"));
    const bits = new Uint16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
    const ids = await this.videoIdsByFileName();
    this.dimension = manifest.dimension;
    for (const entry of manifest.entries) {
      const videoIds = ids.get(entry.fileName) ?? [];
      if (!videoIds.length) continue;
      const vectors = entry.timestamps.map((_, index) =>
        halvesToFloats(
          bits.subarray(
            (entry.offset + index) * manifest.dimension,
            (entry.offset + index + 1) * manifest.dimension
          )
        )
      );
      for (const videoId of videoIds)
        this.videos.set(videoId, {
          meta: {
            videoId,
            modelRevision: entry.modelRevision,
            storyboardGeneratedAt: new Date(entry.storyboardGeneratedAt),
            intervalSeconds: entry.intervalSeconds,
            frameCount: vectors.length,
          },
          timestamps: entry.timestamps,
          vectors,
        });
    }
  }

  async searchFrames(vector: Float32Array, options: FrameSearchOptions): Promise<FrameHit[]> {
    await this.load();
    const only = options.videoIds ? new Set(options.videoIds) : null;
    const excluded = new Set(options.excludeVideoIds ?? []);
    const hits: FrameHit[] = [];
    for (const [videoId, video] of this.videos) {
      if ((only && !only.has(videoId)) || excluded.has(videoId)) continue;
      video.vectors.forEach((frame, frameIndex) =>
        hits.push({
          videoId,
          frameIndex,
          timestampSeconds: video.timestamps[frameIndex]!,
          similarity: dot(vector, frame),
        })
      );
    }
    return hits.sort((a, b) => b.similarity - a.similarity).slice(0, options.limit);
  }

  async frameVector(videoId: number, timestampSeconds: number) {
    await this.load();
    const video = this.videos.get(videoId);
    if (!video?.vectors.length) return null;
    let best = 0;
    video.timestamps.forEach((t, index) => {
      if (Math.abs(t - timestampSeconds) < Math.abs(video.timestamps[best]! - timestampSeconds))
        best = index;
    });
    return video.vectors[best]!;
  }

  async videoFrames(videoId: number) {
    await this.load();
    const video = this.videos.get(videoId);
    return { timestamps: video?.timestamps ?? [], vectors: video?.vectors ?? [] };
  }

  async indexed(videoIds: number[]) {
    await this.load();
    const out = new Map<number, IndexedVideo>();
    for (const id of videoIds) {
      const video = this.videos.get(id);
      if (video) out.set(id, video.meta);
    }
    return out;
  }

  async indexedCount() {
    await this.load();
    let frames = 0;
    for (const video of this.videos.values()) frames += video.vectors.length;
    return { videos: this.videos.size, frames };
  }

  async replaceVideo(meta: IndexedVideo, frames: FrameRow[]) {
    await this.load();
    this.dimension = frames[0]?.vector.length ?? this.dimension;
    this.videos.set(meta.videoId, {
      meta,
      timestamps: frames.map((frame) => frame.timestampSeconds),
      vectors: frames.map((frame) => halvesToFloats(frame.vector)),
    });
  }

  /** Write the in-memory index back to the demo asset files (generation script only). */
  persist(fileNamesById: Map<number, string>) {
    const dir = demoVisualDir();
    mkdirSync(dir, { recursive: true });
    const entries: DemoEntry[] = [];
    const chunks: Uint16Array[] = [];
    let offset = 0;
    const written = new Set<string>();
    for (const [videoId, video] of this.videos) {
      const fileName = fileNamesById.get(videoId);
      if (!fileName || written.has(basename(fileName))) continue;
      written.add(basename(fileName));
      entries.push({
        fileName: basename(fileName),
        modelRevision: video.meta.modelRevision,
        storyboardGeneratedAt: video.meta.storyboardGeneratedAt.toISOString(),
        intervalSeconds: video.meta.intervalSeconds,
        timestamps: video.timestamps,
        offset,
      });
      for (const vector of video.vectors) {
        chunks.push(floatsToHalves(vector));
        offset++;
      }
    }
    const manifest: DemoManifest = { version: 1, dimension: this.dimension, entries };
    writeFileSync(resolve(dir, "index.json"), JSON.stringify(manifest));
    const out = new Uint16Array(offset * this.dimension);
    chunks.forEach((chunk, index) => out.set(chunk, index * this.dimension));
    writeFileSync(resolve(dir, "vectors.f16"), Buffer.from(out.buffer));
  }

  async tagQueries(tagId: number) {
    return this.queries.filter((query) => query.tagId === tagId);
  }

  async addTagQuery(tagId: number, query: string) {
    const existing = this.queries.find((row) => row.tagId === tagId && row.query === query);
    if (existing) return existing;
    const row = { id: this.nextQueryId++, tagId, query, createdAt: new Date() };
    this.queries.push(row);
    return row;
  }

  async removeTagQuery(tagId: number, id: number) {
    const before = this.queries.length;
    this.queries = this.queries.filter((row) => !(row.tagId === tagId && row.id === id));
    return this.queries.length !== before;
  }
}

function floatsToHalves(vector: Float32Array): Uint16Array {
  const out = new Uint16Array(vector.length);
  const f32 = new Float32Array(1);
  const u32 = new Uint32Array(f32.buffer);
  for (let i = 0; i < vector.length; i++) {
    f32[0] = vector[i]!;
    const x = u32[0]!;
    const sign = (x >>> 16) & 0x8000;
    const exponent = ((x >>> 23) & 0xff) - 127 + 15;
    const mantissa = x & 0x7fffff;
    if (exponent <= 0) {
      out[i] = exponent < -10 ? sign : sign | ((mantissa | 0x800000) >> (1 - exponent + 13));
    } else if (exponent >= 0x1f) {
      out[i] = sign | 0x7c00;
    } else {
      out[i] = sign | (exponent << 10) | (mantissa >> 13);
    }
  }
  return out;
}
