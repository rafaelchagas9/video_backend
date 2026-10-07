import { boolean, doublePrecision, integer, jsonb, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { videosTable } from "./videos.schema";

export interface RecordingClip {
  id: string;
  start_seconds: number;
  end_seconds: number;
  peak_seconds: number;
  /** Mean robust z-score of the stretch: how far above this recording's baseline it sits. */
  score: number;
  /** The highlight description that matched the stretch best. */
  label: string;
  keep: boolean;
  /** Set once rendered: the edit job and the clip video it produced. */
  job_id?: number | null;
  output_video_id?: number | null;
  /** Why the reviewer kept, skipped or added it: preset ids or their own words. */
  reasons?: string[];
  /** The edges detection proposed, before trimming; absent on clips added by hand. */
  detected?: { start_seconds: number; end_seconds: number };
}

/**
 * Highlight review of a live recording: proposed clips from visual analysis, the user's
 * keep/adjust decisions, and the render that turns them into library videos.
 */
export const recordingReviewsTable = pgTable("recording_reviews", {
  videoId: integer("video_id")
    .primaryKey()
    .references(() => videosTable.id, { onDelete: "cascade" }),
  /** proposed → rendering → done; dismissed when nothing is worth keeping. */
  status: text("status").notNull().default("proposed"),
  clips: jsonb("clips").$type<RecordingClip[]>().notNull(),
  /** Normalised highlight intensity over the whole recording, for the review timeline. */
  curve: jsonb("curve").$type<number[]>().notNull(),
  promptsRevision: text("prompts_revision").notNull(),
  deleteOriginal: boolean("delete_original").notNull().default(false),
  error: text("error"),
  analyzedAt: timestamp("analyzed_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/**
 * Every keep/skip/add decision made in a review, one row per highlight per analysis.
 * Append-only training data for "what makes a clip worth keeping": it outlives
 * re-analysis (a new analysed_at) and the recording itself (no foreign key).
 */
export const recordingClipFeedbackTable = pgTable(
  "recording_clip_feedback",
  {
    id: serial("id").primaryKey(),
    videoId: integer("video_id").notNull(),
    /** The analysis the highlight came from. */
    analyzedAt: timestamp("analyzed_at").notNull(),
    clipId: text("clip_id").notNull(),
    /** GoondVR channel, from the file name. */
    channel: text("channel"),
    /** What proposed the highlight: the review's detector revision. */
    detector: text("detector").notNull(),
    /** keep | skip */
    verdict: text("verdict").notNull(),
    /** Added by hand: a moment detection missed. */
    added: boolean("added").notNull().default(false),
    reasons: jsonb("reasons").$type<string[]>().notNull().default([]),
    startSeconds: doublePrecision("start_seconds").notNull(),
    endSeconds: doublePrecision("end_seconds").notNull(),
    detectedStart: doublePrecision("detected_start"),
    detectedEnd: doublePrecision("detected_end"),
    peakSeconds: doublePrecision("peak_seconds").notNull(),
    score: doublePrecision("score").notNull(),
    label: text("label").notNull(),
    recordingSeconds: doublePrecision("recording_seconds"),
    /** The decision went as far as rendering the clip. */
    rendered: boolean("rendered").notNull().default(false),
    /** The whole recording was deleted from its review afterwards. */
    recordingDiscarded: boolean("recording_discarded").notNull().default(false),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [uniqueIndex("recording_clip_feedback_clip").on(table.videoId, table.analyzedAt, table.clipId)]
);
