/** Preserve reviewed training data before catalog cascades or source removal. No media is read. */
import { eq, inArray } from "drizzle-orm";
import { db } from "@/config/drizzle";
import { recordingReviewsTable, videosTable } from "@/database/schema";
import { hasRecordingTrainingSnapshot, preserveRecordingTrainingSnapshot } from "./recordings.snapshots.store";
export async function preserveRecordingReviewsBeforeDeletion(ids: number[]): Promise<void> {
  if (!ids.length) return;
  const rows = await db.select({ review: recordingReviewsTable, source: {
    id: videosTable.id, file_name: videosTable.fileName, file_path: videosTable.filePath, file_hash: videosTable.fileHash,
    file_size_bytes: videosTable.fileSizeBytes, duration_seconds: videosTable.durationSeconds, width: videosTable.width, height: videosTable.height,
    codec: videosTable.codec, audio_codec: videosTable.audioCodec, fps: videosTable.fps,
  } }).from(recordingReviewsTable).innerJoin(videosTable, eq(videosTable.id, recordingReviewsTable.videoId)).where(inArray(recordingReviewsTable.videoId, ids));
  for (const row of rows) {
    const review = row.review;
    // Analysis alone is not a reviewed choice: unreviewed/failed analyses may have no index to archive.
    const reviewed = review.savedAt != null || review.status === "rendering" || review.status === "done" ||
      review.clips.some((clip) => clip.job_id != null || clip.output_video_id != null);
    if (reviewed || await hasRecordingTrainingSnapshot(review))
      await preserveRecordingTrainingSnapshot(review, row.source, "before-delete");
  }
}
