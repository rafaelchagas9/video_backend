/**
 * The recorder autopilot's decisions, free of I/O so they can be tested: what a channel's history
 * says about it, and whether it should be recording right now.
 *
 * Why these rules (measured on the reviewed recordings, 2026-10-07):
 * - A live frame read once a minute with the trained probe, starting on two readings in a row
 *   where tease-or-more reaches 85% and stopping after 20 idle minutes, would have covered 93%
 *   of the minutes later kept as clips, while recording about a third of the recordings that
 *   were later thrown away for having nothing in them.
 * - The worth model learns from kept-versus-skipped pairs inside one recording, so a channel stops
 *   adding much once it has a few such recordings; variety across channels matters more.
 */

export const AUTOPILOT_MODES = ["off", "suggest", "auto"] as const;
export type AutopilotMode = (typeof AUTOPILOT_MODES)[number];

/** "target" is no longer entered (data targets are only reported); channels left in it go back to watching. */
export const AUTOPILOT_STATES = ["watching", "recording", "enough", "dropped", "target"] as const;
export type AutopilotState = (typeof AUTOPILOT_STATES)[number];

export interface AutopilotSettings {
  mode: AutopilotMode;
  /** Probability of tease-or-more a live frame needs to count as action. */
  startThreshold: number;
  /** Readings in a row (one a minute) at or above the threshold before recording starts. */
  startReadings: number;
  /** A recording stops after this long without action. */
  idleStopMinutes: number;
  /** ...but never before it has run this long, so a pause in the action does not split it. */
  minRecordMinutes: number;
  /** No new recording starts while this many recordings wait for review (analysed or not). */
  queueLimit: number;
  targets: { pairedRecordings: number; channels: number; keeps: number };
  /** Recordings with both a kept and a skipped highlight after which a channel has given enough. */
  enoughUseful: number;
  /** Latest recordings in a row without a single highlight after which a channel is dropped. */
  dropAfterEmpty: number;
  /** Reviewed recordings without any kept highlight after which a channel is dropped. */
  dropAfterReviewedWithoutKeep: number;
  /** Stored-size limit given to managed channels that have none (MB, 0 leaves them alone). */
  defaultKeepMb: number;
  /** Room-title words: a match never starts a recording. */
  titleBlock: string[];
  /** Room-title words: a match starts on a single reading. */
  titlePrefer: string[];
}

export const DEFAULT_AUTOPILOT_SETTINGS: AutopilotSettings = {
  mode: "auto",
  startThreshold: 0.85,
  startReadings: 2,
  idleStopMinutes: 20,
  minRecordMinutes: 15,
  queueLimit: 25,
  targets: { pairedRecordings: 60, channels: 25, keeps: 150 },
  enoughUseful: 4,
  dropAfterEmpty: 3,
  dropAfterReviewedWithoutKeep: 3,
  defaultKeepMb: 15_360,
  titleBlock: [],
  titlePrefer: [],
};

export interface Outcome {
  status: string;
  clips: number;
  kept: number;
  skipped: number;
  recordedAt: Date | null;
}

export interface ChannelHistory {
  recordings: number;
  /** Latest recordings in a row whose analysis found no highlight at all. */
  emptyStreak: number;
  empty: number;
  reviewed: number;
  /** Recordings with at least one kept and one skipped highlight. */
  useful: number;
  kept: number;
}

export function channelHistory(outcomes: Outcome[]): ChannelHistory {
  const newest = [...outcomes].sort((a, b) => (b.recordedAt?.getTime() ?? 0) - (a.recordedAt?.getTime() ?? 0));
  let emptyStreak = 0;
  for (const outcome of newest) {
    if (outcome.clips > 0) break;
    emptyStreak++;
  }
  return {
    recordings: outcomes.length,
    emptyStreak,
    empty: outcomes.filter((outcome) => outcome.clips === 0).length,
    reviewed: outcomes.filter((outcome) => outcome.kept + outcome.skipped > 0).length,
    useful: outcomes.filter((outcome) => outcome.kept > 0 && outcome.skipped > 0).length,
    kept: outcomes.reduce((sum, outcome) => sum + outcome.kept, 0),
  };
}

/** A state the history settles on its own, whatever is live right now; null when it settles nothing. */
export function settledState(history: ChannelHistory, settings: AutopilotSettings): { state: AutopilotState; reason: string } | null {
  if (history.useful >= settings.enoughUseful)
    return { state: "enough", reason: `${history.useful} recordings with a kept and a skipped clip are enough` };
  if (settings.dropAfterEmpty > 0 && history.emptyStreak >= settings.dropAfterEmpty)
    return { state: "dropped", reason: `the last ${history.emptyStreak} recordings had no highlight at all` };
  if (settings.dropAfterReviewedWithoutKeep > 0 && history.kept === 0 && history.reviewed >= settings.dropAfterReviewedWithoutKeep)
    return { state: "dropped", reason: `${history.reviewed} reviewed recordings without a kept clip` };
  return null;
}

export interface Progress {
  pairedRecordings: number;
  channels: number;
  keeps: number;
}

export function targetReached(progress: Progress, targets: AutopilotSettings["targets"]): boolean {
  return progress.pairedRecordings >= targets.pairedRecordings && progress.channels >= targets.channels && progress.keeps >= targets.keeps;
}

const matches = (title: string, words: string[]) => {
  const lower = title.toLowerCase();
  return words.some((word) => word.trim() && lower.includes(word.trim().toLowerCase()));
};

export interface LiveInput {
  state: AutopilotState;
  stateSince: Date;
  online: boolean;
  hotStreak: number;
  lastHotAt: Date | null;
  title: string;
  /** Why a new recording may not start now (the review queue is full), if anything. */
  blocked: string | null;
  now: Date;
}

/** Whether a watching channel should start, or a recording one stop; null keeps the state. */
export function liveTransition(input: LiveInput, settings: AutopilotSettings): { state: "watching" | "recording"; reason: string } | null {
  const minutes = (from: Date | null) => (from ? (input.now.getTime() - from.getTime()) / 60_000 : Infinity);
  if (input.state === "watching") {
    if (!input.online || input.blocked) return null;
    if (matches(input.title, settings.titleBlock)) return null;
    const needed = matches(input.title, settings.titlePrefer) ? 1 : settings.startReadings;
    if (input.hotStreak >= needed) return { state: "recording", reason: `action in ${input.hotStreak} live frame(s) in a row` };
    return null;
  }
  if (input.state === "recording") {
    const running = minutes(input.stateSince);
    if (running < settings.minRecordMinutes) return null;
    const idle = Math.min(minutes(input.lastHotAt), running);
    if (idle >= settings.idleStopMinutes)
      return { state: "watching", reason: input.online ? `${Math.round(idle)} min without action` : "the stream ended" };
  }
  return null;
}

/** tease + nude + explicit, from probabilities in probe class order (idle first). */
export function actionScore(probabilities: ArrayLike<number>): number {
  return 1 - (probabilities[0] ?? 1);
}
