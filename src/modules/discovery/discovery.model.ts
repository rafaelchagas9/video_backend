/**
 * Taste and rediscovery, as pure functions over library facts.
 *
 * Affinity is per creator because creators are how this library is organised: taste is
 * how long and how often their videos were watched, with recent watching weighing more.
 * Every section answers "what here have I forgotten about?" from a different angle.
 */
import type { CreatorTaste, VideoFact } from "./discovery.source";
import type { HeatPeak } from "./watch-heat.model";

const DAY = 86_400_000;

export interface Affinity {
  creatorId: number;
  name: string;
  /** Lifetime pull of this creator, recency-free. */
  lifetime: number;
  /** Lifetime pull discounted by how long ago it was. */
  current: number;
  lastWatchedAt: Date | null;
}

export function affinities(tastes: CreatorTaste[], now: Date): Affinity[] {
  return tastes
    .map((taste) => {
      const lifetime = Math.log1p(taste.watchSeconds / 60) + taste.plays * 0.35;
      const days = taste.lastWatchedAt ? (now.getTime() - taste.lastWatchedAt.getTime()) / DAY : 365;
      const recency = 0.5 ** (Math.max(0, days) / 90);
      return {
        creatorId: taste.creatorId,
        name: taste.name,
        lifetime,
        current: lifetime * (0.3 + 0.7 * recency),
        lastWatchedAt: taste.lastWatchedAt,
      };
    })
    .filter((affinity) => affinity.lifetime > 0)
    .sort((a, b) => b.current - a.current);
}

/** Seeded PRNG so a section is stable within a day and reshuffles on demand. */
export function seeded(seed: string) {
  let state = 2166136261;
  for (const char of seed) state = Math.imul(state ^ char.charCodeAt(0), 16777619);
  return () => {
    state = Math.imul(state ^ (state >>> 15), 2246822507);
    state = Math.imul(state ^ (state >>> 13), 3266489909);
    state ^= state >>> 16;
    return (state >>> 0) / 4294967296;
  };
}

export function shuffle<T>(items: T[], random: () => number): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export interface SectionItem {
  video_id: number;
  /** A short reason shown on the card ("3 of 145 watched", "Most replayed · 12:40"). */
  reason: string;
  start_seconds?: number;
}

export interface Section {
  id: string;
  title: string;
  subtitle?: string;
  items: SectionItem[];
}

export interface RediscoveryInput {
  videos: VideoFact[];
  tastes: CreatorTaste[];
  /** Replay peaks of videos that have them. */
  peaks: Map<number, HeatPeak[]>;
  now: Date;
  seed: string;
  /** Related videos for the most recently watched video, best first. */
  related?: { sourceVideoId: number; sourceTitle: string; videoIds: number[] };
  /** Display names of creators (from tastes or the library). */
  creatorNames: Map<number, string>;
}

function ago(date: Date, now: Date): string {
  const days = Math.round((now.getTime() - date.getTime()) / DAY);
  if (days < 45) return `${days} days ago`;
  const months = Math.round(days / 30);
  return months < 18 ? `${months} months ago` : `${Math.round(months / 12)} years ago`;
}

function clock(seconds: number): string {
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

const SECTION_SIZE = 18;

export function buildRediscovery(input: RediscoveryInput): Section[] {
  const random = seeded(input.seed);
  const ranked = affinities(input.tastes, input.now);
  const byCreator = new Map<number, VideoFact[]>();
  for (const video of input.videos)
    for (const creatorId of video.creatorIds) {
      const list = byCreator.get(creatorId) ?? [];
      list.push(video);
      byCreator.set(creatorId, list);
    }
  const name = (creatorId: number) => input.creatorNames.get(creatorId) ?? "this creator";
  const used = new Set<number>();
  const take = (items: SectionItem[]) => {
    // A video with several matching creators can be proposed twice by one section.
    const fresh: SectionItem[] = [];
    for (const item of items) {
      if (fresh.length >= SECTION_SIZE) break;
      if (used.has(item.video_id)) continue;
      used.add(item.video_id);
      fresh.push(item);
    }
    return fresh;
  };
  const sections: Section[] = [];

  // 1. Never-played videos by the creators you watch most right now, round-robin.
  const top = ranked.slice(0, 12);
  const pools = top.map((affinity) =>
    shuffle((byCreator.get(affinity.creatorId) ?? []).filter((video) => video.playCount === 0), random)
  );
  const unseen: SectionItem[] = [];
  for (let round = 0; unseen.length < SECTION_SIZE * 2 && pools.some((pool) => pool.length); round++)
    pools.forEach((pool, index) => {
      const video = pool.shift();
      if (video) unseen.push({ video_id: video.id, reason: `New from ${top[index]!.name}` });
    });
  sections.push({
    id: "unseen-favorites",
    title: "Unseen from creators you come back to",
    items: take(unseen),
  });

  // 2. Replay peaks you have not revisited lately: open straight at the good part.
  const stale = input.videos
    .filter((video) => input.peaks.has(video.id))
    .filter((video) => !video.lastWatchedAt || input.now.getTime() - video.lastWatchedAt.getTime() > 21 * DAY)
    .map((video) => ({ video, peak: input.peaks.get(video.id)![0]! }))
    .sort((a, b) => b.peak.intensity * Math.log1p(b.video.watchSeconds) - a.peak.intensity * Math.log1p(a.video.watchSeconds));
  sections.push({
    id: "back-to-the-good-part",
    title: "Back to the good part",
    subtitle: "Your most replayed moments, from videos you haven't opened in a while",
    items: take(
      stale.map(({ video, peak }) => ({
        video_id: video.id,
        reason: `Most replayed · ${clock(peak.peak_seconds)}`,
        start_seconds: Math.max(0, peak.start_seconds),
      }))
    ),
  });

  // 3. Creators you loved who have gone quiet: their most-watched video, as a reminder.
  const quiet = ranked
    .filter((affinity) => affinity.lastWatchedAt && input.now.getTime() - affinity.lastWatchedAt.getTime() > 45 * DAY)
    .sort((a, b) => b.lifetime - a.lifetime)
    .slice(0, SECTION_SIZE * 2);
  const quietItems: SectionItem[] = [];
  for (const affinity of quiet) {
    const videos = (byCreator.get(affinity.creatorId) ?? []).filter((video) => !used.has(video.id));
    const pick =
      videos.filter((video) => video.playCount === 0).sort(() => random() - 0.5)[0] ??
      videos.sort((a, b) => b.watchSeconds - a.watchSeconds)[0];
    if (pick) quietItems.push({ video_id: pick.id, reason: `${affinity.name} · last watched ${ago(affinity.lastWatchedAt!, input.now)}` });
  }
  sections.push({ id: "been-a-while", title: "It's been a while", items: take(quietItems) });

  // 4. Big catalogues you have barely opened.
  const barely = [...byCreator.entries()]
    .map(([creatorId, videos]) => ({
      creatorId,
      total: videos.length,
      seen: videos.filter((video) => video.playCount > 0).length,
      videos,
    }))
    .filter((entry) => entry.total >= 8 && entry.seen / entry.total < 0.2)
    .sort((a, b) => b.total - b.seen - (a.total - a.seen));
  const barelyItems: SectionItem[] = [];
  for (const entry of barely.slice(0, 6)) {
    const unseenVideos = shuffle(entry.videos.filter((video) => video.playCount === 0), random).slice(0, 3);
    for (const video of unseenVideos)
      barelyItems.push({ video_id: video.id, reason: `${name(entry.creatorId)} · ${entry.seen} of ${entry.total} watched` });
  }
  sections.push({
    id: "barely-explored",
    title: "Barely explored",
    subtitle: "Large catalogues you've only scratched",
    items: take(barelyItems),
  });

  // 5. Because you watched — the related service's view of your latest video.
  if (input.related?.videoIds.length)
    sections.push({
      id: "because-you-watched",
      title: `Because you watched ${input.related.sourceTitle}`,
      items: take(input.related.videoIds.map((videoId) => ({ video_id: videoId, reason: "Similar" }))),
    });

  // 6. Long-forgotten additions: never played, in the library for months.
  const forgotten = shuffle(
    input.videos.filter((video) => video.playCount === 0 && input.now.getTime() - video.createdAt.getTime() > 120 * DAY),
    random
  ).map((video) => ({ video_id: video.id, reason: `Added ${ago(video.createdAt, input.now)}, never played` }));
  sections.push({ id: "forgotten", title: "Forgotten in the library", items: take(forgotten) });

  return sections.filter((section) => section.items.length >= 3);
}
