import { boolean, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
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
