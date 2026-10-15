/** Read existing stored embeddings only; this path never invokes the vision service or reads media. */
import { resolve } from "node:path";
import { stat } from "node:fs/promises";
import { eq, sql } from "drizzle-orm";
import { db } from "@/config/drizzle";
import { env } from "@/config/env";
import { videoVisualIndexTable, type RecordingClip, type RecordingProposal } from "@/database/schema";
import type { Video } from "@/modules/videos/videos.types";
import { BadRequestError } from "@/utils/errors";
import { labelTypeOf, type SaveContext } from "./recordings.feedback";
import { readRecordingAudioCache, RECORDING_AUDIO_PIN } from "./recordings.audio-cache";
import { usernameFromFileName } from "./recordings.goondvr";
import { RecordingTrainingSnapshots, snapshotFeatureIdentity, type SnapshotIndex, type SnapshotReview } from "./recordings.snapshots";

function storageRoot(): string {
  const root = env.NODE_ENV === "test" ? process.env.TEST_STORAGE_ROOT : process.cwd();
  if (!root) throw new Error("Training snapshot tests require TEST_STORAGE_ROOT");
  return resolve(root, "data/recording-training-snapshots");
}

/** Existing archives protect legacy decisions that predate savedAt. Existence is not integrity proof. */
export async function hasRecordingTrainingSnapshot(review: Pick<Review, "videoId" | "analyzedAt">): Promise<boolean> {
  const path = resolve(storageRoot(), String(review.videoId), `review-${review.analyzedAt.getTime()}.json`);
  return stat(path).then(() => true).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
}

let archive: RecordingTrainingSnapshots | null = null;
function snapshots(): RecordingTrainingSnapshots {
  if (!archive) {
    // Production uses data/. Tests must never publish snapshots in the real workspace.
    archive = new RecordingTrainingSnapshots(storageRoot());
  }
  return archive;
}

export type SnapshotVideo = Pick<Video, "id" | "file_name" | "file_path" | "file_hash" | "file_size_bytes" | "duration_seconds" | "width" | "height" | "codec" | "audio_codec" | "fps">;
interface Review {
  videoId: number;
  analyzedAt: Date;
  promptsRevision: string;
  status: string;
  clips: RecordingClip[];
  curve: number[];
  proposals?: RecordingProposal[] | null;
}

const indexOf = (row: typeof videoVisualIndexTable.$inferSelect): SnapshotIndex => ({
  modelRevision: row.modelRevision, storyboardGeneratedAt: row.storyboardGeneratedAt.toISOString(),
  indexedAt: row.indexedAt.toISOString(), intervalSeconds: row.intervalSeconds, frameCount: row.frameCount,
});

/** `save` carries the Save's context; later events (render, delete) keep the manifest's but do not know it. */
export async function preserveRecordingTrainingSnapshot(review: Review, video: SnapshotVideo, event: SnapshotReview["event"], save: SaveContext | null = null): Promise<void> {
  if (env.DEMO_MODE) return;
  const source = { videoId: video.id, fileName: video.file_name, fileHash: video.file_hash,
    fileSizeBytes: video.file_size_bytes, durationSeconds: video.duration_seconds, width: video.width,
    height: video.height, codec: video.codec, audioCodec: video.audio_codec, fps: video.fps,
    channel: usernameFromFileName(video.file_name) };
  try {
    const [row] = await db.select().from(videoVisualIndexTable).where(eq(videoVisualIndexTable.videoId, video.id));
    if (!row) throw new Error("This recording has no stored embeddings; a training snapshot cannot be preserved yet");
    const index = indexOf(row);
    await snapshots().save({ source, analyzedAt: review.analyzedAt.toISOString(), detectorRevision: review.promptsRevision,
      status: review.status, clips: review.clips, proposals: review.proposals ?? null, ...(save ? { labelType: labelTypeOf(save) } : {}), save,
      curve: review.curve, event }, index, async () => {
      // The index identity and its frames must come from the same database snapshot, even if a reindex is running.
      return db.transaction(async (tx) => {
        await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
        const [current] = await tx.select().from(videoVisualIndexTable).where(eq(videoVisualIndexTable.videoId, video.id));
        if (!current || snapshotFeatureIdentity(source, indexOf(current)) !== snapshotFeatureIdentity(source, index))
          throw new Error("The visual index changed while saving; retry after indexing finishes");
        const rows = await tx.execute<{ frame_index: number; timestamp_seconds: number; embedding: string }>(sql`
          SELECT frame_index, timestamp_seconds, embedding::text AS embedding FROM video_frame_embeddings
          WHERE video_id = ${video.id} ORDER BY frame_index LIMIT ${index.frameCount + 1}`);
        if (rows.length !== index.frameCount || rows.some((frame, position) => Number(frame.frame_index) !== position))
          throw new Error("The recording's stored frame index is incomplete");
        return { timestamps: rows.map((frame) => Number(frame.timestamp_seconds)),
          vectors: rows.map((frame) => Float32Array.from(JSON.parse(frame.embedding) as number[])) };
      });
    }, async () => {
      const proposals = review.proposals ?? review.clips.map((clip) => ({ ...clip, ...(clip.detected ?? {}) }));
      const cached = await readRecordingAudioCache({ identity: { video_id: video.id, analyzed_at: review.analyzedAt.toISOString(), index_model_revision: index.modelRevision, storyboard_generated_at: index.storyboardGeneratedAt, frame_count: index.frameCount, audio_model_revision: RECORDING_AUDIO_PIN }, proposals, source: { path: video.file_path, sizeBytes: video.file_size_bytes }, freshSource: event === "before-delete" });
      if (!cached.embeddings.size) return null;
      return { modelRevision: RECORDING_AUDIO_PIN, proposals: proposals.filter((proposal) => cached.embeddings.has(proposal.id)).map(({ id, start_seconds, end_seconds }) => ({ id, start_seconds, end_seconds, embedding: cached.embeddings.get(id)! })) };
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "snapshot storage is unavailable";
    throw new BadRequestError(`Could not preserve this review's training snapshot: ${detail}`);
  }
}
