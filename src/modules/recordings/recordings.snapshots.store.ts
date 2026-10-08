/** Read existing stored embeddings only; this path never invokes the vision service or reads media. */
import { resolve } from "node:path";
import { eq, sql } from "drizzle-orm";
import { db } from "@/config/drizzle";
import { env } from "@/config/env";
import { videoVisualIndexTable, type RecordingClip } from "@/database/schema";
import type { Video } from "@/modules/videos/videos.types";
import { BadRequestError } from "@/utils/errors";
import { usernameFromFileName } from "./recordings.goondvr";
import { RecordingTrainingSnapshots, snapshotFeatureIdentity, type SnapshotIndex, type SnapshotReview } from "./recordings.snapshots";

let archive: RecordingTrainingSnapshots | null = null;
function snapshots(): RecordingTrainingSnapshots {
  if (!archive) {
    // Production uses data/. Tests must never publish snapshots in the real workspace.
    const root = env.NODE_ENV === "test" ? process.env.TEST_STORAGE_ROOT : process.cwd();
    if (!root) throw new Error("Training snapshot tests require TEST_STORAGE_ROOT");
    archive = new RecordingTrainingSnapshots(resolve(root, "data/recording-training-snapshots"));
  }
  return archive;
}

interface Review {
  videoId: number;
  analyzedAt: Date;
  promptsRevision: string;
  status: string;
  clips: RecordingClip[];
  curve: number[];
}

const indexOf = (row: typeof videoVisualIndexTable.$inferSelect): SnapshotIndex => ({
  modelRevision: row.modelRevision, storyboardGeneratedAt: row.storyboardGeneratedAt.toISOString(),
  indexedAt: row.indexedAt.toISOString(), intervalSeconds: row.intervalSeconds, frameCount: row.frameCount,
});

export async function preserveRecordingTrainingSnapshot(review: Review, video: Video, event: SnapshotReview["event"]): Promise<void> {
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
      status: review.status, clips: review.clips, curve: review.curve, event }, index, async () => {
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
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "snapshot storage is unavailable";
    throw new BadRequestError(`Could not preserve this review's training snapshot: ${detail}`);
  }
}
