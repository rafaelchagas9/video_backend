/**
 * What the reviewer should do next, from the training data gathered so far (vision-lab
 * clip-review-findings.md, deployed-detector-eval.md, audio-desync.md, 2026-10-22 rundown).
 *
 * The goal is precise "best moments" labels: kept highlights are the best parts of a recording and
 * the rest is not. What teaches that most is several recordings of the same performer (worth is
 * relative to their other streams), recordings whose audio is in sync, and full-length streams.
 * Reconnect fragments lack context and edited compilations have no boring parts to learn from.
 */

/** GoondVR's shared-clock fix went live; captures started earlier may play audio up to 3 s off. */
export const AUDIO_FIX_DEPLOYED = new Date("2026-10-22T03:26:00Z");
/** Shorter than this is a reconnect or unstable-stream fragment. */
export const FRAGMENT_SECONDS = 600;
/**
 * Rough targets for a "best moments" model; earlier precise-cut tries failed at 21 recordings / 10 channels.
 * No in-sync target: the reviewer deletes recordings whose desync is noticeable, so what gets kept is usable.
 */
export const GUIDE_TARGETS = { highlightRecordings: 60, highlightChannels: 20, wholeStreams: 5 } as const;
/** A channel this well covered adds little more: enough precise reviews, or a very large broad history. */
const ENOUGH_HIGHLIGHT_RECORDINGS = 6;
const ENOUGH_RECORDINGS = 15;
const enough = (seen: ChannelHistory) => seen.highlightRecordings >= ENOUGH_HIGHLIGHT_RECORDINGS || seen.recordings >= ENOUGH_RECORDINGS;
const COMPILATION = /highlight|compilation|best[ ._-]?of|\bpmv\b|\bedit(ed)?\b|\bcut\b/i;
const CAPTURE_NAME = /_(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})(?:_\d+)?\.\w+$/;

export interface GuideQueueInput {
  videoId: number;
  fileName: string;
  title: string | null;
  durationSeconds: number | null;
  /** Lower-cased GoondVR channel; null for downloads. */
  channel: string | null;
  /** Not one of GoondVR's captures. */
  library: boolean;
  status: "pending" | "proposed";
}

export interface ChannelHistory {
  recordings: number;
  /** Recordings reviewed in the precise pass. */
  highlightRecordings: number;
  keeps: number;
}

export interface GuideProgressInput {
  highlightRecordings: number;
  highlightChannels: number;
  wholeStreams: number;
  worthOpen: number;
}

export type GuideAction = "review" | "optional" | "delete" | "skip";
export type GuideWarning = "desync";

export interface GuideItem {
  video_id: number;
  action: GuideAction;
  /** Lower first; only meaningful among `review` items. */
  priority: number;
  why: string;
  warnings: GuideWarning[];
}

export interface GuideCreator {
  channel: string;
  recordings: number;
  keeps: number;
  why: string;
  /** The Kura creator this channel belongs to, when one matches. */
  creator_id: number | null;
  /** Where its avatar comes from: the creator's picture, else GoondVR's profile image of `channel_id`. */
  picture: "creator" | "channel" | null;
  channel_id: string | null;
}

export interface CreatorLook {
  creatorId: number | null;
  hasPicture: boolean;
  channelId: string | null;
}

export interface RecordingGuide {
  progress: {
    highlight_recordings: { done: number; target: number };
    highlight_channels: { done: number; target: number };
    whole_streams: { done: number; target: number };
    worth_open: number;
  };
  queue: GuideItem[];
  record_more: GuideCreator[];
  enough: GuideCreator[];
  nothing_kept: GuideCreator[];
  audio_fix_at: string;
}

/** When GoondVR started a capture, from the UTC timestamp in its file name. */
export function capturedAt(fileName: string): Date | null {
  const match = CAPTURE_NAME.exec(fileName);
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)));
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

export function guideItem(item: GuideQueueInput, history: ReadonlyMap<string, ChannelHistory>): GuideItem {
  const at = item.library ? null : capturedAt(item.fileName);
  const warnings: GuideWarning[] = at && at < AUDIO_FIX_DEPLOYED ? ["desync"] : [];
  const base = { video_id: item.videoId, warnings };
  const duration = item.durationSeconds ?? 0;
  if (duration > 0 && duration < FRAGMENT_SECONDS)
    return { ...base, action: "delete", priority: 9, why: "Under 10 minutes: a reconnect fragment without context. Delete it as “Too short / fragment”." };
  if (item.library && COMPILATION.test(`${item.fileName} ${item.title ?? ""}`))
    return { ...base, action: "skip", priority: 9, why: "Looks already edited. A highlight reel has no boring parts to learn from, so it teaches little." };
  const seen = item.channel ? history.get(item.channel) : undefined;
  if (seen && enough(seen))
    return { ...base, action: "optional", priority: 5, why: `${plural(seen.recordings, "recording")} of this channel already reviewed. More add little; review it only for the clips.` };
  if (seen && seen.recordings > 0)
    return { ...base, action: "review", priority: 2, why: `${plural(seen.recordings, "earlier recording")} of this channel reviewed. Comparing streams of one performer teaches what their best looks like.` };
  if (item.library)
    return { ...base, action: "review", priority: 3, why: "A full downloaded stream: long and in sync. Good for picking the best moments." };
  return { ...base, action: "review", priority: 4, why: "First recording of this channel. Useful, and more so once there is a second one to compare." };
}

export function buildGuide(
  queue: readonly GuideQueueInput[],
  history: ReadonlyMap<string, ChannelHistory>,
  progress: GuideProgressInput,
  looks: ReadonlyMap<string, CreatorLook> = new Map()
): RecordingGuide {
  const items = queue.map((item) => guideItem(item, history));
  const order: Record<GuideAction, number> = { review: 0, optional: 1, delete: 2, skip: 3 };
  items.sort((a, b) => order[a.action] - order[b.action] || a.priority - b.priority);
  const channels = [...history.entries()].map(([channel, seen]) => ({ channel, ...seen }));
  const creator = (entry: (typeof channels)[number], why: string): GuideCreator => {
    const look = looks.get(entry.channel);
    const picture = look?.creatorId && look.hasPicture ? "creator" : look?.channelId ? "channel" : null;
    return { channel: entry.channel, recordings: entry.recordings, keeps: entry.keeps, why, creator_id: look?.creatorId ?? null, picture, channel_id: look?.channelId ?? null };
  };
  return {
    progress: {
      highlight_recordings: { done: progress.highlightRecordings, target: GUIDE_TARGETS.highlightRecordings },
      highlight_channels: { done: progress.highlightChannels, target: GUIDE_TARGETS.highlightChannels },
      whole_streams: { done: progress.wholeStreams, target: GUIDE_TARGETS.wholeStreams },
      worth_open: progress.worthOpen,
    },
    queue: items,
    // Kept something worth having, but too few recordings to compare; most kept per recording first.
    record_more: channels
      .filter((entry) => entry.keeps > 0 && entry.recordings < 4)
      .sort((a, b) => b.keeps / b.recordings - a.keeps / a.recordings || b.keeps - a.keeps)
      .map((entry) => creator(entry, `${plural(entry.keeps, "kept highlight")} from ${plural(entry.recordings, "recording")}. A few more let the model compare their streams.`)),
    enough: channels
      .filter((entry) => enough(entry))
      .sort((a, b) => b.recordings - a.recordings)
      .map((entry) => creator(entry, `${plural(entry.recordings, "recording")} reviewed. Record only for the clips.`)),
    nothing_kept: channels
      .filter((entry) => entry.recordings >= 3 && entry.keeps === 0)
      .sort((a, b) => b.recordings - a.recordings)
      .map((entry) => creator(entry, `Nothing kept in ${plural(entry.recordings, "recording")}.`)),
    audio_fix_at: AUDIO_FIX_DEPLOYED.toISOString(),
  };
}
