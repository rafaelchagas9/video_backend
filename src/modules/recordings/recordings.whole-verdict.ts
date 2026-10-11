/** Explicit current whole-recording judgments; never clip, cut or permanent-storage labels. */
import { z } from "zod";
import { BadRequestError } from "@/utils/errors";

export const WHOLE_VERDICT_ANSWERS = ["keep_entire", "edited_parts_only", "nothing_worth_keeping", "unsure"] as const;
export type WholeVerdictAnswer = (typeof WHOLE_VERDICT_ANSWERS)[number];
const instant = z.string().min(1).refine((value) => Number.isFinite(Date.parse(value)), "Invalid generation timestamp");
const identity = z.string().regex(/^[0-9a-f]{64}$/);
const contextSchema = z.object({
  target: z.literal("current_whole_recording_review"),
  reserved_fine_holdout: z.literal(false),
  fine_data_role: z.literal("training"),
  candidate: z.object({
    video_id: z.number().int().positive(), analyzed_at: instant,
    index: z.object({ model_revision: z.literal("siglip2/so400m-patch16-256"), frame_count: z.number().int().positive().max(8000), interval_seconds: z.literal(5), storyboard_generated_at: instant, indexed_at: instant }).strict(),
    source_fingerprint: z.object({ size_bytes: z.number().int().nonnegative(), mtime_ns: z.string().regex(/^\d+$/), path_identity_sha256: identity }).strict(),
    duration_seconds: z.number().finite().positive(), channel: z.string().min(1), channel_key: z.string().min(1),
  }).strict(),
  original_range: z.tuple([z.literal(0), z.number().finite().positive()]),
}).strict();

export function validateWholeVerdict(context: Record<string, unknown>, detail: Record<string, unknown> | null,
  task: { videoId: number; startSeconds: number; endSeconds: number }, reasons: readonly string[] = []): void {
  const parsed = contextSchema.safeParse(context);
  if (!parsed.success || detail !== null || reasons.length !== 0) throw new BadRequestError("Whole-recording judgments require an exact frozen recording and no clip details");
  const { candidate, original_range } = parsed.data;
  if (candidate.channel_key !== candidate.channel.replace(/^@/, "").toLowerCase() || candidate.video_id !== task.videoId ||
      task.startSeconds !== 0 || task.endSeconds !== candidate.duration_seconds || original_range[1] !== candidate.duration_seconds)
    throw new BadRequestError("Whole-recording playback must cover the exact current recording");
}
