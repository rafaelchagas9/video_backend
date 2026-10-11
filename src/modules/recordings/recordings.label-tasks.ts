/**
 * Labelling tasks outside the review queue, answered from the Label tasks page:
 *
 * * **recall-audit** — a stretch of an already reviewed recording, drawn by
 *   vision-lab/recall_audit.py from time the detector did not propose (or newly proposes). Keep
 *   means "something here was worth keeping", the same triage bar as the review; the stratum's
 *   weight scales answers back up to how much such time exists.
 * * **versus** — two keeps, within or across channels, drawn from existing recordings where the baseline
 *   cannot tell them apart: a/b chooses the stronger current candidate; both is no strict preference;
 *   neither rejects both. An a/b loser remains a current candidate. Saved selected-side cuts
 *   (`detail.best`) are valid refinements, including manually adjusted edges.
 * * **whole-verdict** — an explicit keep-as-is decision for the entire current recording.
 *   Edited parts, nothing and unsure remain separate answers; no clip feedback or cuts are written.
 * * **refine** — retired: a whole-clip "worth saving or nice to watch" mixed a clip's length with
 *   its worth. Its answers stay, written onto the decisions' feedback rows; no new ones are made.
 */
import { sql } from "drizzle-orm";
import { db } from "@/config/drizzle";
import { env } from "@/config/env";
import { RECORDING_REFINEMENTS } from "@/database/schema";
import { BadRequestError, NotFoundError } from "@/utils/errors";
import { demoLabelTasks, saveDemoLabelAnswer } from "./recordings.demo-fixtures";
import { validateVersionPreference } from "./recordings.version-versus";
import { WHOLE_VERDICT_ANSWERS, validateWholeVerdict } from "./recordings.whole-verdict";

export const LABEL_TASK_KINDS = ["recall-audit", "versus", "version-versus", "whole-verdict", "refine"] as const;
export type LabelTaskKind = (typeof LABEL_TASK_KINDS)[number];

const ANSWERS: Record<LabelTaskKind, readonly string[]> = {
  "recall-audit": ["keep", "skip"],
  versus: ["a", "b", "both", "neither"],
  "version-versus": ["a", "b", "both", "neither"],
  "whole-verdict": WHOLE_VERDICT_ANSWERS,
  refine: RECORDING_REFINEMENTS,
};


export interface LabelTask {
  id: number;
  kind: LabelTaskKind;
  batch: string;
  stratum: string;
  position: number;
  video_id: number;
  file_name: string;
  duration_seconds: number | null;
  start_seconds: number;
  end_seconds: number;
  channel: string | null;
  context: Record<string, unknown>;
  answer: string | null;
  reasons: string[];
  detail: Record<string, unknown> | null;
  answered_at: string | null;
}

/** A versus pair's sides carry their recording's length, for playing and trimming them. */
function withDurations(context: Record<string, unknown>, a: unknown, b: unknown): Record<string, unknown> {
  const side = (value: unknown, duration: unknown) =>
    value && typeof value === "object" ? { ...value, duration_seconds: duration === null || duration === undefined ? null : Number(duration) } : value;
  return "a" in context && "b" in context ? { ...context, a: side(context.a, a), b: side(context.b, b) } : context;
}

export async function listLabelTasks(): Promise<{ tasks: LabelTask[] }> {
  if (env.DEMO_MODE) return { tasks: demoLabelTasks() };
  // Tasks whose recording is gone can no longer be played; refine tasks are no longer asked.
  const rows = await db.execute<Record<string, unknown>>(sql`
    SELECT t.*, coalesce(v.file_name, '') AS file_name, v.duration_seconds,
      (SELECT b.duration_seconds FROM videos b WHERE b.id = (t.context->'b'->>'video_id')::int) AS b_duration_seconds
    FROM recording_label_tasks t
    JOIN videos v ON v.id = t.video_id
    WHERE t.kind <> 'refine'
      AND (t.kind NOT IN ('versus', 'version-versus') OR EXISTS (SELECT 1 FROM videos b WHERE b.id = (t.context->'b'->>'video_id')::int))
    ORDER BY t.kind, t.batch, t.position, t.id`);
  return {
    tasks: rows.map((row) => ({
      id: Number(row.id),
      kind: row.kind as LabelTaskKind,
      batch: String(row.batch),
      stratum: String(row.stratum),
      position: Number(row.position),
      video_id: Number(row.video_id),
      file_name: String(row.file_name),
      duration_seconds: row.duration_seconds === null ? null : Number(row.duration_seconds),
      start_seconds: Number(row.start_seconds),
      end_seconds: Number(row.end_seconds),
      channel: (row.channel as string | null) ?? null,
      context: withDurations((row.context as Record<string, unknown>) ?? {}, row.duration_seconds, row.b_duration_seconds),
      answer: (row.answer as string | null) ?? null,
      reasons: (row.reasons as string[]) ?? [],
      detail: (row.detail as Record<string, unknown> | null) ?? null,
      answered_at: row.answered_at ? new Date(row.answered_at as string).toISOString() : null,
    })),
  };
}

/** Answers a task, or with a null answer reopens it. A refine answer also labels its keep. */
export async function answerLabelTask(
  id: number,
  answer: string | null,
  reasons: string[] = [],
  detail: Record<string, unknown> | null = null
): Promise<LabelTask> {
  if (env.DEMO_MODE) {
    const task = demoLabelTasks().find((entry) => entry.id === id);
    if (!task) throw new NotFoundError("No such labelling task");
    validateAnswer(task, answer, reasons, detail);
    return saveDemoLabelAnswer(task, answer, reasons, detail);
  }
  const [task] = await db.execute<{ kind: LabelTaskKind; context: Record<string, unknown>; video_id: number; start_seconds: number; end_seconds: number }>(
    sql`SELECT kind, context, video_id, start_seconds, end_seconds FROM recording_label_tasks WHERE id = ${id}`
  );
  if (!task) throw new NotFoundError("No such labelling task");
  validateAnswer(task, answer, reasons, detail);
  // Raw SQL parameters bypass the schema timestamp encoder. Send a string
  // so postgres-js can bind the timestamp column without receiving a Date.
  const answeredAt = answer === null ? null : new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      UPDATE recording_label_tasks
      SET answer = ${answer}, reasons = ${JSON.stringify(answer ? reasons : [])}::jsonb,
        detail = ${answer && detail ? JSON.stringify(detail) : null}::jsonb, answered_at = ${answeredAt}
      WHERE id = ${id}`);
    const feedbackId = Number(task.context.feedback_id);
    if (task.kind === "refine" && Number.isInteger(feedbackId))
      await tx.execute(sql`
        UPDATE recording_clip_feedback SET refinement = ${answer}, refinement_at = ${answeredAt}
        WHERE id = ${feedbackId} AND verdict = 'keep'`);
  });
  const { tasks } = await listLabelTasks();
  const updated = tasks.find((entry) => entry.id === id);
  if (!updated) throw new NotFoundError("The task's recording is gone");
  return updated;
}

function validateAnswer(task: Pick<LabelTask, "kind" | "context" | "video_id" | "start_seconds" | "end_seconds">, answer: string | null, reasons: string[], detail: Record<string, unknown> | null): void {
  if (answer !== null && !ANSWERS[task.kind]?.includes(answer)) throw new BadRequestError(`A ${task.kind} task is answered with ${ANSWERS[task.kind]?.join(" or ")}`);
  if (task.kind === "version-versus" && answer !== null) validateVersionPreference(task.context, detail);
  if (task.kind === "whole-verdict") validateWholeVerdict(task.context, detail, { videoId: Number(task.video_id), startSeconds: Number(task.start_seconds), endSeconds: Number(task.end_seconds) }, reasons);
}
