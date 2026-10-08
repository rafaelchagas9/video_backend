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

/** A highlight as detection proposed it, before any review: never rewritten by trims or merges. */
export interface RecordingProposal {
  id: string;
  start_seconds: number;
  end_seconds: number;
  peak_seconds: number;
  score: number;
  label: string;
  /** The default the reviewer was shown: false when detection marked it a likely skip. */
  keep: boolean;
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
  /** This analysis' proposals as shown, kept through trims and merges; null on reviews older than the column. */
  proposals: jsonb("proposals").$type<RecordingProposal[]>(),
  /** When a reviewer first confirmed this analysis' decisions; null while only proposed. */
  savedAt: timestamp("saved_at"),
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
    /**
     * The proposal was merged into this clip id of the same analysis; its own row keeps the
     * original range but is not a separate decision and is left out of counts.
     */
    mergedInto: text("merged_into"),
    /** What the review showed before the reviewer acted: keep | likely-skip; null when added by hand. */
    shownDefault: text("shown_default"),
    /**
     * What the verdict means. triage: "has potential", a coarse call on a proposed stretch;
     * trimming edges does not make it a refinement label.
     */
    labelType: text("label_type").notNull().default("triage"),
    /** The Save that last confirmed this decision; one id per Save. */
    saveBatch: text("save_batch"),
    /** The recording's 0-based place in the review queue when it was opened, and that queue's sort. */
    queuePosition: integer("queue_position"),
    queueSort: text("queue_sort"),
    /** The recording belongs to the random audit slice, placed in the queue regardless of training value. */
    audit: boolean("audit").notNull().default(false),
    /** Kept and rendered footage the channel already had from its other recordings, when this was saved. */
    channelKeptSeconds: doublePrecision("channel_kept_seconds"),
    channelRenderedSeconds: doublePrecision("channel_rendered_seconds"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [uniqueIndex("recording_clip_feedback_clip").on(table.videoId, table.analyzedAt, table.clipId)]
);

/**
 * The recorder autopilot's view of each GoondVR channel: whether it manages the channel, the
 * state it decided on and why, and the live readings behind that decision.
 */
export const recorderAutopilotChannelsTable = pgTable("recorder_autopilot_channels", {
  /** GoondVR's `<site>__<username>` id. */
  channelId: text("channel_id").primaryKey(),
  /** False hands the channel back to the user: the autopilot never pauses or resumes it. */
  managed: boolean("managed").notNull().default(true),
  /** watching | recording | enough | dropped */
  state: text("state").notNull().default("watching"),
  reason: text("reason"),
  stateSince: timestamp("state_since").defaultNow().notNull(),
  /** The last live-frame state probabilities, in probe class order. */
  lastReading: jsonb("last_reading").$type<number[]>(),
  lastReadingAt: timestamp("last_reading_at"),
  /** Consecutive readings at or above the start threshold. */
  hotStreak: integer("hot_streak").notNull().default(0),
  lastHotAt: timestamp("last_hot_at"),
  readings: integer("readings").notNull().default(0),
  hotReadings: integer("hot_readings").notNull().default(0),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/** Every start, stop and state change the autopilot made (or, in suggest mode, would have made). */
export const recorderAutopilotEventsTable = pgTable("recorder_autopilot_events", {
  id: serial("id").primaryKey(),
  channelId: text("channel_id"),
  /** start | stop | state | target | limits */
  action: text("action").notNull(),
  reason: text("reason").notNull(),
  /** False in suggest mode, or when GoondVR refused. */
  applied: boolean("applied").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/**
 * What each analysed recording yielded, kept after the recording is deleted so a channel's
 * history (empty recordings, useful ones) survives clean-ups. No foreign key on purpose.
 */
export const recorderAutopilotOutcomesTable = pgTable("recorder_autopilot_outcomes", {
  videoId: integer("video_id").primaryKey(),
  /** GoondVR username, from the file name. */
  channel: text("channel").notNull(),
  fileName: text("file_name").notNull(),
  status: text("status").notNull(),
  clips: integer("clips").notNull(),
  kept: integer("kept").notNull(),
  skipped: integer("skipped").notNull(),
  recordedAt: timestamp("recorded_at"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
