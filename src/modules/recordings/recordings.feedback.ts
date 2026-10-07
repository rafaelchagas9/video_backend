import { and, eq, notInArray, sql } from "drizzle-orm";
import { db } from "@/config/drizzle";
import { env } from "@/config/env";
import { recordingClipFeedbackTable, type RecordingClip } from "@/database/schema";
import { usernameFromFileName } from "./recordings.goondvr";

/**
 * The reviewer's decisions, kept as training data for what makes a clip worth keeping.
 * One row per highlight per analysis, rewritten each time the review is saved, so it
 * always holds the latest decision; a new analysis starts new rows and leaves the old.
 */

type FeedbackRow = typeof recordingClipFeedbackTable.$inferInsert;
export type ReasonKind = "keep" | "skip" | "added";

export interface FeedbackSummary {
  clips: number;
  kept: number;
  skipped: number;
  added: number;
  explained: number;
  recordings: number;
  reasons: { reason: string; kind: ReasonKind; count: number }[];
}

interface Source {
  videoId: number;
  analyzedAt: Date;
  promptsRevision: string;
  fileName: string | null;
  durationSeconds: number | null;
}

/* The demo database resets on every start, like its reviews. */
const demoFeedback = new Map<string, FeedbackRow>();
const demoKey = (row: Pick<FeedbackRow, "videoId" | "analyzedAt" | "clipId">) => `${row.videoId}|${row.analyzedAt.getTime()}|${row.clipId}`;

const isAdded = (clip: RecordingClip) => clip.id.startsWith("added-");
const kindOf = (row: Pick<FeedbackRow, "verdict" | "added">): ReasonKind => (row.verdict === "skip" ? "skip" : row.added ? "added" : "keep");

function toRow(source: Source, clip: RecordingClip, rendered: boolean): FeedbackRow {
  return {
    videoId: source.videoId,
    analyzedAt: source.analyzedAt,
    clipId: clip.id,
    channel: source.fileName ? usernameFromFileName(source.fileName) : null,
    detector: source.promptsRevision,
    verdict: clip.keep ? "keep" : "skip",
    added: isAdded(clip),
    reasons: clip.reasons ?? [],
    startSeconds: clip.start_seconds,
    endSeconds: clip.end_seconds,
    detectedStart: clip.detected?.start_seconds ?? null,
    detectedEnd: clip.detected?.end_seconds ?? null,
    peakSeconds: clip.peak_seconds,
    score: clip.score,
    label: clip.label,
    recordingSeconds: source.durationSeconds,
    rendered: rendered && clip.keep,
    updatedAt: new Date(),
  };
}

/** Records the review's current decisions; highlights merged away or removed since lose their rows. */
export async function recordFeedback(source: Source, clips: RecordingClip[], options: { rendered?: boolean } = {}): Promise<void> {
  const rows = clips.map((clip) => toRow(source, clip, Boolean(options.rendered || clip.job_id || clip.output_video_id)));
  const ids = clips.map((clip) => clip.id);
  if (env.DEMO_MODE) {
    for (const [key, row] of demoFeedback)
      if (row.videoId === source.videoId && row.analyzedAt.getTime() === source.analyzedAt.getTime() && !ids.includes(row.clipId)) demoFeedback.delete(key);
    for (const row of rows) demoFeedback.set(demoKey(row), { ...demoFeedback.get(demoKey(row)), ...row });
    return;
  }
  await db.transaction(async (tx) => {
    const sameAnalysis = and(eq(recordingClipFeedbackTable.videoId, source.videoId), eq(recordingClipFeedbackTable.analyzedAt, source.analyzedAt));
    await tx.delete(recordingClipFeedbackTable).where(ids.length ? and(sameAnalysis, notInArray(recordingClipFeedbackTable.clipId, ids)) : sameAnalysis);
    for (const row of rows) {
      const { videoId: _v, analyzedAt: _a, clipId: _c, ...update } = row;
      await tx
        .insert(recordingClipFeedbackTable)
        .values(row)
        .onConflictDoUpdate({
          target: [recordingClipFeedbackTable.videoId, recordingClipFeedbackTable.analyzedAt, recordingClipFeedbackTable.clipId],
          // Once rendered, a decision stays rendered.
          set: { ...update, rendered: sql`${recordingClipFeedbackTable.rendered} OR ${update.rendered ?? false}` },
        });
    }
  });
}

/** The recording was thrown away from its review: every decision recorded for it says so. */
export async function markRecordingDiscarded(videoId: number): Promise<void> {
  if (env.DEMO_MODE) {
    for (const row of demoFeedback.values()) if (row.videoId === videoId) row.recordingDiscarded = true;
    return;
  }
  await db
    .update(recordingClipFeedbackTable)
    .set({ recordingDiscarded: true, updatedAt: new Date() })
    .where(eq(recordingClipFeedbackTable.videoId, videoId));
}

export async function feedbackSummary(): Promise<FeedbackSummary> {
  const rows: Pick<FeedbackRow, "videoId" | "verdict" | "added" | "reasons">[] = env.DEMO_MODE
    ? [...demoFeedback.values()]
    : await db
        .select({
          videoId: recordingClipFeedbackTable.videoId,
          verdict: recordingClipFeedbackTable.verdict,
          added: recordingClipFeedbackTable.added,
          reasons: recordingClipFeedbackTable.reasons,
        })
        .from(recordingClipFeedbackTable);
  const counts = new Map<string, { reason: string; kind: ReasonKind; count: number }>();
  for (const row of rows) {
    const kind = kindOf(row);
    for (const reason of row.reasons ?? []) {
      const key = `${kind}|${reason.toLowerCase()}`;
      const entry = counts.get(key) ?? { reason, kind, count: 0 };
      entry.count += 1;
      counts.set(key, entry);
    }
  }
  return {
    clips: rows.length,
    kept: rows.filter((row) => row.verdict === "keep").length,
    skipped: rows.filter((row) => row.verdict === "skip").length,
    added: rows.filter((row) => row.added).length,
    explained: rows.filter((row) => row.reasons?.length).length,
    recordings: new Set(rows.map((row) => row.videoId)).size,
    reasons: [...counts.values()].sort((a, b) => b.count - a.count),
  };
}
