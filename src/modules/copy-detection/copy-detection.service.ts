import { mkdir, open, rm, stat } from "node:fs/promises";
import { endianness } from "node:os";
import { resolve } from "node:path";
import { and, asc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { db } from "@/config/drizzle";
import { env } from "@/config/env";
import {
  videoAudioFingerprintsTable,
  videoCopyPairsTable,
  videosTable,
} from "@/database/schema";
import { NotFoundError } from "@/utils/errors";
import { runCopyEngine, type EnginePair, type EngineProgress } from "./copy-detection.engine";
import {
  extractFingerprint,
  FINGERPRINT_HOP_SECONDS,
  FINGERPRINT_REVISION,
} from "./copy-detection.fingerprint";
import {
  assessPerceptualMatch,
  PERCEPTUAL_ASSESSMENT_REVISION,
  RELEVANCE_POLICY,
} from "./copy-detection.relevance";
import {
  COPY_DETECTION_REVISION,
  engineMatchSchema,
  intervalCoverage,
  type CopyDetectionResults,
  type CopyMatch,
} from "./copy-detection.schemas";

type Video = { id: number; filePath: string; durationSeconds: number | null };
export type ProcessResult = {
  fingerprint: "extracted" | "reused" | "no_audio";
  items?: number;
};
/** Live state of a comparison pass, surfaced to the synchronization screens. */
export type MatchProgress = {
  stage: "prepare" | EngineProgress["stage"];
  done: number;
  total: number;
  matches: number;
  rejected: number;
};
export type MatchSummary = {
  pending: number;
  fingerprints: number;
  candidates: number;
  matches: number;
  rejected: number;
  seconds: number;
};

const PACK_MAGIC = Buffer.from("CPFP0001", "ascii");

async function identity(path: string) {
  const s = await stat(path, { bigint: true });
  if (!s.isFile()) throw new NotFoundError("Video file is unavailable");
  return { size: Number(s.size), mtimeNs: s.mtimeNs.toString() };
}

function toBytes(items: Uint32Array): Buffer {
  if (endianness() !== "LE") throw new Error("Fingerprint storage assumes a little-endian host");
  return Buffer.from(items.buffer, items.byteOffset, items.byteLength);
}

/** Engine output → the segment contract shared with the relevance policy and the Kura UI. */
export function toMatch(pair: EnginePair, durationA: number, durationB: number): CopyMatch | null {
  const segments = pair.segments
    .map((s) => {
      const group = pair.groups[s.group];
      const motion = group?.motion ?? null;
      return {
        a_start: s.a_start,
        a_end: Math.min(s.a_end, durationA),
        b_start: s.b_start,
        b_end: Math.min(s.b_end, durationB),
        speed: 1,
        matched_frames: s.items,
        spatial_inliers: group?.inliers ?? 0,
        status: s.status,
        motion: motion === null ? 0 : Math.max(0, Math.min(1, motion)),
        timing_error_seconds: Number((FINGERPRINT_HOP_SECONDS / 2).toFixed(4)),
        ...(motion === null ? {} : { temporal_motion_similarity: Math.max(-1, Math.min(1, motion)) }),
      };
    })
    .filter((s) => s.a_end > s.a_start && s.b_end > s.b_start);
  if (!segments.length) return null;
  return engineMatchSchema.parse({
    video_a: pair.video_a,
    video_b: pair.video_b,
    status: segments.some((s) => s.status === "verified") ? "verified" : "ambiguous",
    segments,
    coverage_a: intervalCoverage(segments.map((s) => [s.a_start, s.a_end]), durationA),
    coverage_b: intervalCoverage(segments.map((s) => [s.b_start, s.b_end]), durationB),
  });
}

export class CopyDetectionService {
  constructor(
    private readonly options: {
      pythonPath: string;
      workDir: string;
      cacheDir: string;
      ffmpegPath: string;
      ffprobePath: string;
      fpcalcPath: string;
      engineTimeoutMs: number;
    }
  ) {}

  /** Videos whose fingerprint matches the file on disk and has been compared with the library. */
  async processedIds(videos: Video[]): Promise<Set<number>> {
    const found = new Set<number>();
    if (!videos.length) return found;
    const rows = await db
      .select({
        videoId: videoAudioFingerprintsTable.videoId,
        sourceSize: videoAudioFingerprintsTable.sourceSize,
        sourceMtimeNs: videoAudioFingerprintsTable.sourceMtimeNs,
      })
      .from(videoAudioFingerprintsTable)
      .where(
        and(
          eq(videoAudioFingerprintsTable.revision, FINGERPRINT_REVISION),
          sql`${videoAudioFingerprintsTable.matchedAt} IS NOT NULL`
        )
      );
    const byId = new Map(rows.map((r) => [r.videoId, r]));
    const candidates = videos.filter((v) => byId.has(v.id));
    // bounded stat concurrency: do not hammer a network or spinning library at once
    for (let i = 0; i < candidates.length; i += 32) {
      await Promise.all(
        candidates.slice(i, i + 32).map(async (video) => {
          const row = byId.get(video.id)!;
          try {
            const current = await identity(video.filePath);
            if (current.size === row.sourceSize && current.mtimeNs === row.sourceMtimeNs)
              found.add(video.id);
          } catch {
            // a missing file is simply not processed
          }
        })
      );
    }
    return found;
  }

  /** Fingerprints one video (reusing a current fingerprint). Matching happens in matchPending. */
  async process(videoId: number, signal: AbortSignal): Promise<ProcessResult> {
    const [video] = await db
      .select({
        id: videosTable.id,
        filePath: videosTable.filePath,
        durationSeconds: videosTable.durationSeconds,
      })
      .from(videosTable)
      .where(and(eq(videosTable.id, videoId), eq(videosTable.isAvailable, true)));
    if (!video) throw new NotFoundError("Video is unavailable");
    const before = await identity(video.filePath);
    const [existing] = await db
      .select({
        revision: videoAudioFingerprintsTable.revision,
        status: videoAudioFingerprintsTable.status,
        itemCount: videoAudioFingerprintsTable.itemCount,
        sourceSize: videoAudioFingerprintsTable.sourceSize,
        sourceMtimeNs: videoAudioFingerprintsTable.sourceMtimeNs,
      })
      .from(videoAudioFingerprintsTable)
      .where(eq(videoAudioFingerprintsTable.videoId, videoId));
    if (
      existing?.revision === FINGERPRINT_REVISION &&
      existing.sourceSize === before.size &&
      existing.sourceMtimeNs === before.mtimeNs
    )
      return existing.status === "no_audio"
        ? { fingerprint: "no_audio" }
        : { fingerprint: "reused", items: existing.itemCount };

    // CPU and disk only: no GPU slot from the media scheduler is needed
    const result = await extractFingerprint(video.filePath, {
      ffmpegPath: this.options.ffmpegPath,
      fpcalcPath: this.options.fpcalcPath,
      durationSeconds: video.durationSeconds,
      signal,
    });
    const after = await identity(video.filePath);
    if (after.size !== before.size || after.mtimeNs !== before.mtimeNs) {
      throw Object.assign(new Error("Video changed while it was fingerprinted"), {
        code: "COPY_SOURCE_CHANGED",
      });
    }
    const values = {
      revision: FINGERPRINT_REVISION,
      status: result.status,
      sourceSize: before.size,
      sourceMtimeNs: before.mtimeNs,
      itemCount: result.status === "ready" ? result.items.length : 0,
      fingerprint: result.status === "ready" ? toBytes(result.items) : null,
      extractedAt: new Date(),
      matchedAt: null,
    };
    await db.transaction(async (tx) => {
      await tx
        .insert(videoAudioFingerprintsTable)
        .values({ videoId, ...values })
        .onConflictDoUpdate({ target: videoAudioFingerprintsTable.videoId, set: values });
      // decisions about the previous content of this file no longer hold
      await tx
        .delete(videoCopyPairsTable)
        .where(or(eq(videoCopyPairsTable.videoA, videoId), eq(videoCopyPairsTable.videoB, videoId)));
    });
    return result.status === "ready"
      ? { fingerprint: "extracted", items: result.items.length }
      : { fingerprint: "no_audio" };
  }

  /** Compares every not-yet-matched fingerprint with the whole library and stores decisions. */
  async matchPending(
    signal: AbortSignal,
    onProgress?: (progress: MatchProgress) => void
  ): Promise<MatchSummary> {
    const startedAt = new Date();
    const pendingRows = await db
      .select({ videoId: videoAudioFingerprintsTable.videoId, status: videoAudioFingerprintsTable.status })
      .from(videoAudioFingerprintsTable)
      .innerJoin(videosTable, eq(videosTable.id, videoAudioFingerprintsTable.videoId))
      .where(
        and(
          isNull(videoAudioFingerprintsTable.matchedAt),
          eq(videoAudioFingerprintsTable.revision, FINGERPRINT_REVISION),
          eq(videosTable.isAvailable, true)
        )
      );
    const empty = { pending: 0, fingerprints: 0, candidates: 0, matches: 0, rejected: 0, seconds: 0 };
    if (!pendingRows.length) return empty;
    const pendingIds = pendingRows.map((r) => r.videoId);
    const focus = pendingRows.filter((r) => r.status === "ready").map((r) => r.videoId);

    let summary: MatchSummary = { ...empty, pending: pendingIds.length };
    const retry = new Set<number>();
    const live: MatchProgress = { stage: "prepare", done: 0, total: 0, matches: 0, rejected: 0 };
    onProgress?.({ ...live });
    if (focus.length) {
      const videos = await db
        .select({
          id: videosTable.id,
          filePath: videosTable.filePath,
          durationSeconds: videosTable.durationSeconds,
        })
        .from(videosTable)
        .where(eq(videosTable.isAvailable, true));
      const durations = new Map(videos.map((v) => [v.id, v.durationSeconds ?? 0]));
      await mkdir(this.options.cacheDir, { recursive: true, mode: 0o700 });
      const packPath = resolve(this.options.cacheDir, `fingerprints-${process.pid}-${Date.now()}.bin`);
      try {
        const packed = await this.writePack(packPath, signal);
        const decided = await db
          .select({ a: videoCopyPairsTable.videoA, b: videoCopyPairsTable.videoB })
          .from(videoCopyPairsTable)
          .where(
            and(
              eq(videoCopyPairsTable.revision, COPY_DETECTION_REVISION),
              or(inArray(videoCopyPairsTable.videoA, focus), inArray(videoCopyPairsTable.videoB, focus))
            )
          );
        const done = await runCopyEngine(
          {
            pythonPath: this.options.pythonPath,
            workDir: this.options.workDir,
            ffmpegPath: this.options.ffmpegPath,
            ffprobePath: this.options.ffprobePath,
            timeoutMs: this.options.engineTimeoutMs,
          },
          {
            version: 1,
            fingerprints: packPath,
            videos: Object.fromEntries(
              videos
                .filter((v) => (v.durationSeconds ?? 0) > 0)
                .map((v) => [String(v.id), { path: v.filePath, duration: v.durationSeconds! }])
            ),
            focus_ids: focus,
            skip_pairs: decided.map((p) => [p.a, p.b] as [number, number]),
            policy: {
              min_overlap_seconds: RELEVANCE_POLICY.minimumOverlapSeconds,
              min_overlap_coverage: RELEVANCE_POLICY.minimumOverlapCoverage,
              min_similarity_coverage: RELEVANCE_POLICY.minimumSimilarityCoverage,
              min_clip_seconds: RELEVANCE_POLICY.minimumClipEvidenceSeconds,
            },
          },
          signal,
          {
            onProgress: (p) => {
              Object.assign(live, { stage: p.stage, done: p.done, total: p.total });
              onProgress?.({ ...live });
            },
            onPair: async (pair) => {
              const verdict = await this.savePair(pair, durations);
              live[verdict === "match" ? "matches" : "rejected"]++;
              onProgress?.({ ...live });
            },
          }
        );
        for (const [a, b] of done.failed_pairs) {
          retry.add(a);
          retry.add(b);
        }
        summary = {
          pending: pendingIds.length,
          fingerprints: packed,
          candidates: done.candidates,
          matches: done.matches,
          rejected: done.rejected,
          seconds: done.seconds,
        };
      } finally {
        await rm(packPath, { force: true });
      }
    }
    // A fingerprint re-extracted during this pass was not part of it and stays pending, as do
    // videos of pairs the engine could not decide.
    const completed = pendingIds.filter((id) => !retry.has(id));
    if (!completed.length) return summary;
    await db
      .update(videoAudioFingerprintsTable)
      .set({ matchedAt: new Date() })
      .where(
        and(
          inArray(videoAudioFingerprintsTable.videoId, completed),
          isNull(videoAudioFingerprintsTable.matchedAt),
          lte(videoAudioFingerprintsTable.extractedAt, startedAt)
        )
      );
    return summary;
  }

  private async savePair(pair: EnginePair, durations: Map<number, number>) {
    const durationA = durations.get(pair.video_a) ?? 0;
    const durationB = durations.get(pair.video_b) ?? 0;
    const match = pair.verdict === "match" && durationA > 0 && durationB > 0
      ? toMatch(pair, durationA, durationB)
      : null;
    const values = {
      revision: COPY_DETECTION_REVISION,
      verdict: match ? "match" : "rejected",
      status: match ? match.status : null,
      coverageA: match?.coverage_a ?? 0,
      coverageB: match?.coverage_b ?? 0,
      segments: match?.segments ?? [],
      evidence: { groups: pair.groups, audio: pair.audio, source_error: pair.source_error },
      checkedAt: new Date(),
    };
    await db
      .insert(videoCopyPairsTable)
      .values({ videoA: pair.video_a, videoB: pair.video_b, ...values })
      .onConflictDoUpdate({
        target: [videoCopyPairsTable.videoA, videoCopyPairsTable.videoB],
        set: values,
      });
    return values.verdict;
  }

  /** Streams every ready fingerprint of an available video into the engine's binary pack. */
  private async writePack(path: string, signal: AbortSignal): Promise<number> {
    const file = await open(path, "wx", 0o600);
    try {
      let position = 12;
      let count = 0;
      let after = 0;
      for (;;) {
        signal.throwIfAborted();
        const rows = await db
          .select({
            videoId: videoAudioFingerprintsTable.videoId,
            itemCount: videoAudioFingerprintsTable.itemCount,
            fingerprint: videoAudioFingerprintsTable.fingerprint,
          })
          .from(videoAudioFingerprintsTable)
          .innerJoin(videosTable, eq(videosTable.id, videoAudioFingerprintsTable.videoId))
          .where(
            and(
              gt(videoAudioFingerprintsTable.videoId, after),
              eq(videoAudioFingerprintsTable.status, "ready"),
              eq(videoAudioFingerprintsTable.revision, FINGERPRINT_REVISION),
              eq(videosTable.isAvailable, true)
            )
          )
          .orderBy(asc(videoAudioFingerprintsTable.videoId))
          .limit(200);
        if (!rows.length) break;
        for (const row of rows) {
          const bytes = row.fingerprint!;
          const header = Buffer.alloc(8);
          header.writeInt32LE(row.videoId, 0);
          header.writeUInt32LE(row.itemCount, 4);
          await file.write(header, 0, 8, position);
          await file.write(bytes, 0, bytes.length, position + 8);
          position += 8 + bytes.length;
          count++;
        }
        after = rows.at(-1)!.videoId;
      }
      const head = Buffer.alloc(12);
      PACK_MAGIC.copy(head, 0);
      head.writeUInt32LE(count, 8);
      await file.write(head, 0, 12, 0);
      return count;
    } finally {
      await file.close();
    }
  }

  async results({
    limit,
    offset,
    view = "copies",
  }: {
    limit: number;
    offset: number;
    view?: "copies" | "similarity";
  }): Promise<CopyDetectionResults> {
    const videos = await db
      .select({
        id: videosTable.id,
        durationSeconds: videosTable.durationSeconds,
        title: videosTable.title,
        fileName: videosTable.fileName,
      })
      .from(videosTable)
      .where(eq(videosTable.isAvailable, true));
    const byId = new Map(videos.map((v) => [v.id, v]));
    const [{ fingerprints }] = await db
      .select({ fingerprints: sql<number>`count(*)::int` })
      .from(videoAudioFingerprintsTable)
      .where(eq(videoAudioFingerprintsTable.status, "ready"));
    const rows = await db
      .select()
      .from(videoCopyPairsTable)
      .where(
        and(
          eq(videoCopyPairsTable.revision, COPY_DETECTION_REVISION),
          eq(videoCopyPairsTable.verdict, "match")
        )
      )
      .orderBy(sql`${videoCopyPairsTable.checkedAt} DESC`);
    let suppressed = 0;
    // Each pair is listed under its longer video: a livestream gathers all of its clips.
    const owners = new Map<number, { latest: number; matches: CopyDetectionResults["items"][number]["matches"] }>();
    for (const row of rows) {
      const a = byId.get(row.videoA);
      const b = byId.get(row.videoB);
      if (!a?.durationSeconds || !b?.durationSeconds) continue;
      const parsed = engineMatchSchema.safeParse({
        video_a: row.videoA,
        video_b: row.videoB,
        status: row.status,
        segments: row.segments,
        coverage_a: row.coverageA,
        coverage_b: row.coverageB,
      });
      if (!parsed.success) continue;
      const assessment = assessPerceptualMatch(parsed.data, a.durationSeconds, b.durationSeconds);
      if (assessment.group === "suppressed") suppressed++;
      if (assessment.group !== view) continue;
      const owner =
        a.durationSeconds > b.durationSeconds || (a.durationSeconds === b.durationSeconds && a.id < b.id)
          ? a.id
          : b.id;
      const entry = owners.get(owner) ?? { latest: row.checkedAt.getTime(), matches: [] };
      entry.matches.push({ ...parsed.data, assessment });
      owners.set(owner, entry);
    }
    const items = [...owners.entries()]
      .sort((x, y) => y[1].latest - x[1].latest || y[0] - x[0])
      .map(([videoId, entry]) => ({
        version: 1 as const,
        revision: COPY_DETECTION_REVISION as typeof COPY_DETECTION_REVISION,
        video_id: videoId,
        compared_videos: fingerprints,
        retrieval_truncated: false,
        skipped_references: 0,
        match_count: entry.matches.length,
        matches: entry.matches.slice(0, 50),
        truncated_matches: entry.matches.length > 50,
        candidate_limited_pairs: 0,
      }));
    const page = items.slice(offset, offset + limit);
    const visible = new Set(page.flatMap((i) => i.matches.flatMap((m) => [m.video_a, m.video_b])));
    return {
      items: page,
      video_labels: Object.fromEntries(
        [...visible].map((id) => {
          const v = byId.get(id)!;
          return [String(id), v.title?.trim() || v.fileName];
        })
      ),
      total: items.length,
      limit,
      offset,
      assessment_revision: PERCEPTUAL_ASSESSMENT_REVISION,
      diagnostics: {
        candidate_limited_pairs: 0,
        truncated_videos: items.filter((i) => i.truncated_matches).length,
        suppressed_matches: suppressed,
        retrieval_limited_videos: 0,
      },
    };
  }
}

let service: CopyDetectionService | null = null;
export function getCopyDetectionService(): CopyDetectionService {
  service ??= new CopyDetectionService({
    pythonPath: env.COPY_DETECTION_PYTHON_PATH,
    workDir: env.COPY_DETECTION_WORK_DIR,
    cacheDir: resolve(env.COPY_DETECTION_CACHE_DIR),
    ffmpegPath: env.FFMPEG_PATH,
    ffprobePath: env.FFPROBE_PATH,
    fpcalcPath: env.FPCALC_PATH,
    engineTimeoutMs: env.COPY_DETECTION_TIMEOUT_MS,
  });
  return service;
}
