/**
 * Labelling tasks outside the review queue, answered from the Label tasks page:
 *
 * * **recall-audit** — a stretch of an already reviewed recording, drawn by
 *   vision-lab/recall_audit.py from time the detector did not propose (or newly proposes). Keep
 *   means "something here was worth keeping", the same triage bar as the review; the stratum's
 *   weight scales answers back up to how much such time exists.
 * * **refine** — a past keep, asked again at the refinement bar: worth saving, or only nice to
 *   watch, given what its channel already holds. Created here for every confirmed keep without a
 *   refinement; the answer is written onto that decision's feedback row.
 */
import { sql } from "drizzle-orm";
import { db } from "@/config/drizzle";
import { env } from "@/config/env";
import { RECORDING_REFINEMENTS } from "@/database/schema";
import { BadRequestError, NotFoundError } from "@/utils/errors";
import { confirmedDecisions } from "./recordings.feedback";

export const LABEL_TASK_KINDS = ["recall-audit", "refine"] as const;
export type LabelTaskKind = (typeof LABEL_TASK_KINDS)[number];

const ANSWERS: Record<LabelTaskKind, readonly string[]> = {
  "recall-audit": ["keep", "skip"],
  refine: RECORDING_REFINEMENTS,
};

/** The refine round for keeps confirmed before the review asked for a refinement itself. */
const REFINE_BATCH = "refine-1";

export interface LabelTask {
  id: number;
  kind: LabelTaskKind;
  batch: string;
  stratum: string;
  video_id: number;
  file_name: string;
  duration_seconds: number | null;
  start_seconds: number;
  end_seconds: number;
  channel: string | null;
  context: Record<string, unknown>;
  answer: string | null;
  reasons: string[];
  answered_at: string | null;
}

/**
 * One refine task per confirmed keep that has no refinement and no task yet. It plays the
 * recording when the catalogue still holds it, else the clip rendered from it alone.
 */
async function ensureRefineTasks(): Promise<void> {
  await db.execute(sql`
    INSERT INTO recording_label_tasks (kind, batch, video_id, start_seconds, end_seconds, stratum, position, channel, context)
    SELECT 'refine', ${REFINE_BATCH}, source.video_id, source.start_seconds, source.end_seconds, 'keep',
      ('x' || substr(md5(f.id::text), 1, 7))::bit(28)::int, lower(regexp_replace(f.channel, '^@', '')),
      jsonb_build_object('feedback_id', f.id, 'recording_id', f.video_id, 'analyzed_at', f.analyzed_at, 'clip_id', f.clip_id,
        'score', f.score, 'baseline_rank', f.baseline_rank, 'rendered_clip', source.video_id <> f.video_id)
    FROM ${confirmedDecisions} f
    CROSS JOIN LATERAL (
      SELECT v.id AS video_id, f.start_seconds, f.end_seconds FROM videos v WHERE v.id = f.video_id
      UNION ALL
      SELECT out.id, 0, coalesce(out.duration_seconds, f.end_seconds - f.start_seconds)
      FROM recording_reviews r
      CROSS JOIN LATERAL jsonb_array_elements(r.clips) c
      JOIN videos out ON out.id = (c->>'output_video_id')::int
      WHERE r.video_id = f.video_id AND c->>'id' = f.clip_id
        AND NOT EXISTS (SELECT 1 FROM videos v WHERE v.id = f.video_id)
        AND (SELECT count(*) FROM jsonb_array_elements(r.clips) other WHERE other->>'output_video_id' = c->>'output_video_id') = 1
      LIMIT 1
    ) source
    WHERE f.verdict = 'keep' AND f.refinement IS NULL
      AND NOT EXISTS (SELECT 1 FROM recording_label_tasks t WHERE t.kind = 'refine' AND (t.context->>'feedback_id')::int = f.id)
    ON CONFLICT DO NOTHING`);
}

export async function listLabelTasks(): Promise<{ tasks: LabelTask[] }> {
  if (env.DEMO_MODE) return { tasks: [] };
  await ensureRefineTasks();
  // A refine task whose keep was refined in its review since, or skipped since, is no longer asked.
  const rows = await db.execute<Record<string, unknown>>(sql`
    SELECT t.*, coalesce(v.file_name, '') AS file_name, v.duration_seconds
    FROM recording_label_tasks t
    LEFT JOIN videos v ON v.id = t.video_id
    LEFT JOIN recording_clip_feedback f ON t.kind = 'refine' AND f.id = (t.context->>'feedback_id')::int
    WHERE v.id IS NOT NULL
      AND (t.kind <> 'refine' OR t.answer IS NOT NULL OR (f.verdict = 'keep' AND f.refinement IS NULL))
    ORDER BY t.kind, t.batch, t.position, t.id`);
  return {
    tasks: rows.map((row) => ({
      id: Number(row.id),
      kind: row.kind as LabelTaskKind,
      batch: String(row.batch),
      stratum: String(row.stratum),
      video_id: Number(row.video_id),
      file_name: String(row.file_name),
      duration_seconds: row.duration_seconds === null ? null : Number(row.duration_seconds),
      start_seconds: Number(row.start_seconds),
      end_seconds: Number(row.end_seconds),
      channel: (row.channel as string | null) ?? null,
      context: (row.context as Record<string, unknown>) ?? {},
      answer: (row.answer as string | null) ?? null,
      reasons: (row.reasons as string[]) ?? [],
      answered_at: row.answered_at ? new Date(row.answered_at as string).toISOString() : null,
    })),
  };
}

/** Answers a task, or with a null answer reopens it. A refine answer also labels its keep. */
export async function answerLabelTask(id: number, answer: string | null, reasons: string[] = []): Promise<LabelTask> {
  if (env.DEMO_MODE) throw new NotFoundError("The demo has no labelling tasks");
  const [task] = await db.execute<{ kind: LabelTaskKind; context: Record<string, unknown> }>(
    sql`SELECT kind, context FROM recording_label_tasks WHERE id = ${id}`
  );
  if (!task) throw new NotFoundError("No such labelling task");
  if (answer !== null && !ANSWERS[task.kind]?.includes(answer)) throw new BadRequestError(`A ${task.kind} task is answered with ${ANSWERS[task.kind]?.join(" or ")}`);
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      UPDATE recording_label_tasks
      SET answer = ${answer}, reasons = ${JSON.stringify(answer ? reasons : [])}::jsonb, answered_at = ${answer ? new Date() : null}
      WHERE id = ${id}`);
    const feedbackId = Number(task.context.feedback_id);
    if (task.kind === "refine" && Number.isInteger(feedbackId))
      await tx.execute(sql`
        UPDATE recording_clip_feedback SET refinement = ${answer}, refinement_at = ${answer ? new Date() : null}
        WHERE id = ${feedbackId} AND verdict = 'keep'`);
  });
  const { tasks } = await listLabelTasks();
  const updated = tasks.find((entry) => entry.id === id);
  if (!updated) throw new NotFoundError("The task's recording is gone");
  return updated;
}
