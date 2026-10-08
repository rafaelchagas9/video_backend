import { and, eq, notInArray, sql } from "drizzle-orm";
import { db } from "@/config/drizzle";
import { env } from "@/config/env";
import { recordingClipFeedbackTable, type RecordingClip, type RecordingProposal } from "@/database/schema";
import { usernameFromFileName } from "./recordings.goondvr";

/**
 * The reviewer's decisions, kept as training data for what makes a clip worth keeping.
 * One row per highlight per analysis (a generation), rewritten each time the review is saved,
 * so it always holds the latest decision; a new analysis starts new rows and leaves the old.
 * Proposals merged into another highlight keep their row, marked with what they joined.
 *
 * Counts read one generation per recording, its latest confirmed one, and leave merged-away
 * proposals out: two analyses of one recording are not two recordings, and a merge is one decision.
 */

type FeedbackRow = typeof recordingClipFeedbackTable.$inferInsert;
export type ReasonKind = "keep" | "skip" | "added";

/** Every verdict today is a coarse "has potential" call; trims do not make it a refinement. */
export const LABEL_TYPE = "triage";

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
  /** The analysis' proposals as shown; null on reviews older than the column. */
  proposals: RecordingProposal[] | null;
}

/** Where and how the reviewer confirmed the decisions; absent for clients that do not say. */
export interface SaveContext {
  batch: string;
  queuePosition: number | null;
  queueSort: string | null;
  audit: boolean;
}

/**
 * Confirmed decisions that count: each recording's latest saved generation, merged-away
 * proposals left out. Use as a table: `FROM ${confirmedDecisions} f`.
 */
export const confirmedDecisions = sql`(
  SELECT f.* FROM recording_clip_feedback f
  JOIN (SELECT video_id, max(analyzed_at) AS analyzed_at FROM recording_clip_feedback GROUP BY video_id) latest
    ON latest.video_id = f.video_id AND latest.analyzed_at = f.analyzed_at
  WHERE f.merged_into IS NULL
)`;

/* The demo database resets on every start, like its reviews. */
const demoFeedback = new Map<string, FeedbackRow>();
const demoKey = (row: Pick<FeedbackRow, "videoId" | "analyzedAt" | "clipId">) => `${row.videoId}|${row.analyzedAt.getTime()}|${row.clipId}`;

const isAdded = (clip: Pick<RecordingClip, "id">) => clip.id.startsWith("added-");
const kindOf = (row: Pick<FeedbackRow, "verdict" | "added">): ReasonKind => (row.verdict === "skip" ? "skip" : row.added ? "added" : "keep");
const channelKey = (channel: string) => channel.replace(/^@/, "").toLowerCase();

/** The current highlight a vanished proposal went into: the one holding its peak, else the most overlap. */
export function mergeTarget(proposal: Pick<RecordingProposal, "start_seconds" | "end_seconds" | "peak_seconds">, clips: RecordingClip[]): RecordingClip | null {
  const holding = clips.find((clip) => clip.start_seconds <= proposal.peak_seconds && proposal.peak_seconds <= clip.end_seconds);
  if (holding) return holding;
  const overlap = (clip: RecordingClip) => Math.min(clip.end_seconds, proposal.end_seconds) - Math.max(clip.start_seconds, proposal.start_seconds);
  const best = [...clips].sort((a, b) => overlap(b) - overlap(a))[0];
  return best && overlap(best) > 0 ? best : null;
}

/**
 * One row per current highlight plus one per proposal that is no longer a highlight of its own.
 * Original detected ranges and shown defaults come from the proposals, so trims and merges
 * never rewrite what detection proposed.
 */
export function feedbackRows(
  source: Source,
  clips: RecordingClip[],
  options: { rendered?: boolean; context?: SaveContext | null; channel?: { keptSeconds: number; renderedSeconds: number } | null } = {}
): FeedbackRow[] {
  const proposals = new Map((source.proposals ?? []).map((proposal) => [proposal.id, proposal]));
  const shown = (id: string) => {
    const proposal = proposals.get(id);
    return proposal ? (proposal.keep ? "keep" : "likely-skip") : null;
  };
  const common = {
    videoId: source.videoId,
    analyzedAt: source.analyzedAt,
    channel: source.fileName ? usernameFromFileName(source.fileName) : null,
    detector: source.promptsRevision,
    recordingSeconds: source.durationSeconds,
    labelType: LABEL_TYPE,
    ...(options.context
      ? { saveBatch: options.context.batch, queuePosition: options.context.queuePosition, queueSort: options.context.queueSort, audit: options.context.audit }
      : {}),
    ...(options.channel ? { channelKeptSeconds: options.channel.keptSeconds, channelRenderedSeconds: options.channel.renderedSeconds } : {}),
    updatedAt: new Date(),
  };
  const rows: FeedbackRow[] = clips.map((clip) => {
    const proposal = proposals.get(clip.id);
    const detected = proposal ?? clip.detected;
    return {
      ...common,
      clipId: clip.id,
      verdict: clip.keep ? "keep" : "skip",
      added: isAdded(clip),
      reasons: clip.reasons ?? [],
      startSeconds: clip.start_seconds,
      endSeconds: clip.end_seconds,
      detectedStart: detected?.start_seconds ?? null,
      detectedEnd: detected?.end_seconds ?? null,
      peakSeconds: clip.peak_seconds,
      score: clip.score,
      label: clip.label,
      rendered: Boolean(options.rendered || clip.job_id || clip.output_video_id) && clip.keep,
      mergedInto: null,
      shownDefault: shown(clip.id),
    };
  });
  const current = new Set(clips.map((clip) => clip.id));
  for (const proposal of proposals.values()) {
    if (current.has(proposal.id)) continue;
    const target = mergeTarget(proposal, clips);
    rows.push({
      ...common,
      clipId: proposal.id,
      verdict: target?.keep ? "keep" : "skip",
      added: false,
      reasons: [],
      startSeconds: proposal.start_seconds,
      endSeconds: proposal.end_seconds,
      detectedStart: proposal.start_seconds,
      detectedEnd: proposal.end_seconds,
      peakSeconds: proposal.peak_seconds,
      score: proposal.score,
      label: proposal.label,
      rendered: false,
      // A proposal can only leave the list by a merge; one with no overlap left is still accounted for.
      mergedInto: target?.id ?? "removed",
      shownDefault: shown(proposal.id),
    });
  }
  return rows;
}

/** Kept and rendered seconds the channel's other recordings already hold in confirmed decisions. */
async function channelFootage(channel: string | null, videoId: number): Promise<{ keptSeconds: number; renderedSeconds: number } | null> {
  if (!channel) return null;
  if (env.DEMO_MODE) {
    let keptSeconds = 0;
    let renderedSeconds = 0;
    for (const row of confirmedDemoRows())
      if (row.videoId !== videoId && row.channel && channelKey(row.channel) === channelKey(channel) && row.verdict === "keep") {
        keptSeconds += row.endSeconds - row.startSeconds;
        if (row.rendered) renderedSeconds += row.endSeconds - row.startSeconds;
      }
    return { keptSeconds, renderedSeconds };
  }
  const [row] = await db.execute<{ kept: number | null; rendered: number | null }>(sql`
    SELECT
      sum(f.end_seconds - f.start_seconds) FILTER (WHERE f.verdict = 'keep') AS kept,
      sum(f.end_seconds - f.start_seconds) FILTER (WHERE f.verdict = 'keep' AND f.rendered) AS rendered
    FROM ${confirmedDecisions} f
    WHERE f.video_id <> ${videoId} AND lower(regexp_replace(f.channel, '^@', '')) = ${channelKey(channel)}`);
  return { keptSeconds: Number(row?.kept ?? 0), renderedSeconds: Number(row?.rendered ?? 0) };
}

/**
 * Records the review's current decisions. Highlights added by hand and removed since lose
 * their rows; proposals merged away keep theirs, pointing at what they joined.
 */
export async function recordFeedback(
  source: Source,
  clips: RecordingClip[],
  options: { rendered?: boolean; context?: SaveContext | null } = {}
): Promise<void> {
  // The channel's footage is read when the reviewer decides, not again when the clips render.
  const channel = options.rendered ? null : await channelFootage(source.fileName ? usernameFromFileName(source.fileName) : null, source.videoId);
  const rows = feedbackRows(source, clips, { ...options, channel });
  const ids = rows.map((row) => row.clipId);
  if (env.DEMO_MODE) {
    for (const [key, row] of demoFeedback)
      if (row.videoId === source.videoId && row.analyzedAt.getTime() === source.analyzedAt.getTime() && !ids.includes(row.clipId)) demoFeedback.delete(key);
    for (const row of rows) {
      const earlier = demoFeedback.get(demoKey(row));
      demoFeedback.set(demoKey(row), { ...earlier, ...row, rendered: Boolean(earlier?.rendered || row.rendered) });
    }
    return;
  }
  await db.transaction(async (tx) => {
    const sameAnalysis = and(eq(recordingClipFeedbackTable.videoId, source.videoId), eq(recordingClipFeedbackTable.analyzedAt, source.analyzedAt));
    // Only rows nothing accounts for any more: an added highlight removed, or (on reviews without
    // stored proposals) one merged away before proposals were kept.
    await tx.delete(recordingClipFeedbackTable).where(ids.length ? and(sameAnalysis, notInArray(recordingClipFeedbackTable.clipId, ids)) : sameAnalysis);
    for (const row of rows) {
      const { videoId: _v, analyzedAt: _a, clipId: _c, ...update } = row;
      await tx
        .insert(recordingClipFeedbackTable)
        .values(row)
        .onConflictDoUpdate({
          target: [recordingClipFeedbackTable.videoId, recordingClipFeedbackTable.analyzedAt, recordingClipFeedbackTable.clipId],
          // Once rendered, a decision stays rendered. Context a call does not carry is left as saved.
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

/** The demo's rows as `confirmedDecisions` reads them. */
function confirmedDemoRows(): FeedbackRow[] {
  const latest = new Map<number, number>();
  for (const row of demoFeedback.values()) latest.set(row.videoId, Math.max(latest.get(row.videoId) ?? 0, row.analyzedAt.getTime()));
  return [...demoFeedback.values()].filter((row) => !row.mergedInto && latest.get(row.videoId) === row.analyzedAt.getTime());
}

export async function feedbackSummary(): Promise<FeedbackSummary> {
  const rows: Pick<FeedbackRow, "videoId" | "verdict" | "added" | "reasons">[] = env.DEMO_MODE
    ? confirmedDemoRows()
    : (
        await db.execute<{ video_id: number; verdict: string; added: boolean; reasons: string[] }>(sql`
          SELECT f.video_id, f.verdict, f.added, f.reasons FROM ${confirmedDecisions} f`)
      ).map((row) => ({ videoId: Number(row.video_id), verdict: String(row.verdict), added: Boolean(row.added), reasons: row.reasons ?? [] }));
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
