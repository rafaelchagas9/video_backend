import { videosSearchService } from "@/modules/videos/videos.search.service";
import type { Video } from "@/modules/videos/videos.types";
import { visualSearchService } from "@/modules/visual-search/visual-search.service";
import { buildRediscovery, seeded, shuffle, type Section } from "./discovery.model";
import { loadBookmarks, loadLibraryFacts, loadRelated, type VideoFact } from "./discovery.source";
import { watchHeatService } from "./watch-heat.service";

export type MomentSource = "bookmark" | "replayed" | "visual";

export interface FeedMoment {
  /** Stable within a feed, for list keys and de-duplication. */
  id: string;
  video_id: number;
  start_seconds: number;
  end_seconds: number;
  peak_seconds: number;
  source: MomentSource;
  label: string | null;
}

export interface MomentFeedQuery {
  mode: "mix" | "bookmarks" | "replayed" | "query";
  query?: string | undefined;
  creatorId?: number | undefined;
  seed: string;
  offset: number;
  limit: number;
}

const MIN_CLIP = 10;
const MAX_CLIP = 45;

/** A playable window around a moment: long enough to land, short enough to stay a highlight. */
export function clipWindow(
  start: number,
  end: number,
  peak: number,
  duration: number
): { start: number; end: number; peak: number } {
  let from = Math.max(0, start);
  let to = Math.min(duration || Number.POSITIVE_INFINITY, Math.max(end, from + MIN_CLIP));
  if (to - from > MAX_CLIP) {
    from = Math.max(0, peak - MAX_CLIP / 3);
    to = from + MAX_CLIP;
  }
  if (duration) to = Math.min(to, duration);
  return { start: Math.round(from * 10) / 10, end: Math.round(to * 10) / 10, peak: Math.round(peak * 10) / 10 };
}

async function hydrate(userId: number, ids: number[]): Promise<Video[]> {
  const unique = [...new Set(ids)];
  const videos: Video[] = [];
  for (let offset = 0; offset < unique.length; offset += 100) {
    const chunk = unique.slice(offset, offset + 100);
    const page = await videosSearchService.list(userId, {
      ids: chunk,
      limit: chunk.length,
      include: ["creators", "artwork"],
    });
    videos.push(...page.data);
  }
  return videos;
}

export class DiscoveryService {
  async home(userId: number, seed: string): Promise<{ sections: Section[]; videos: Video[] }> {
    const facts = await loadLibraryFacts(userId);
    const durations = new Map(facts.videos.map((video) => [video.id, video.durationSeconds]));
    const peaks = await watchHeatService.peaksFor(durations);
    const latest = facts.videos
      .filter((video) => video.lastWatchedAt)
      .sort((a, b) => b.lastWatchedAt!.getTime() - a.lastWatchedAt!.getTime())[0];
    const creatorNames = new Map(facts.tastes.map((taste) => [taste.creatorId, taste.name]));
    const [relatedIds, missingNames] = await Promise.all([
      latest ? loadRelated(userId, latest.id, 24) : Promise.resolve([]),
      this.creatorNames(userId, facts.videos, creatorNames),
    ]);
    for (const [id, name] of missingNames) creatorNames.set(id, name);
    const latestVideo = latest ? (await hydrate(userId, [latest.id]))[0] : undefined;
    const sections = buildRediscovery({
      videos: facts.videos,
      tastes: facts.tastes,
      peaks,
      now: new Date(),
      seed,
      creatorNames,
      ...(latest && latestVideo
        ? {
            related: {
              sourceVideoId: latest.id,
              sourceTitle: latestVideo.title?.trim() || latestVideo.file_name,
              videoIds: relatedIds,
            },
          }
        : {}),
    });
    const videos = await hydrate(userId, sections.flatMap((section) => section.items.map((item) => item.video_id)));
    return { sections, videos };
  }

  /** Names for creators of large untouched catalogues, who have no watch history. */
  private async creatorNames(userId: number, videos: VideoFact[], known: Map<number, string>) {
    const counts = new Map<number, number>();
    for (const video of videos)
      for (const creatorId of video.creatorIds) counts.set(creatorId, (counts.get(creatorId) ?? 0) + 1);
    const wanted = [...counts.entries()].filter(([id, count]) => count >= 8 && !known.has(id)).map(([id]) => id);
    const names = new Map<number, string>();
    if (!wanted.length) return names;
    // Videos carry their creators' names; one sample video per creator is enough.
    const sample = wanted
      .map((creatorId) => videos.find((video) => video.creatorIds.includes(creatorId))?.id)
      .filter((id): id is number => id !== undefined);
    for (const video of await hydrate(userId, sample))
      for (const creator of video.creators ?? []) if (wanted.includes(creator.id)) names.set(creator.id, creator.name);
    return names;
  }

  async moments(userId: number, query: MomentFeedQuery) {
    const facts = await loadLibraryFacts(userId);
    const byId = new Map(facts.videos.map((video) => [video.id, video]));
    const allowed = (videoId: number) => {
      const video = byId.get(videoId);
      return Boolean(video) && (!query.creatorId || video!.creatorIds.includes(query.creatorId));
    };
    const candidates: FeedMoment[] = [];
    const add = (videoId: number, start: number, end: number, peak: number, source: MomentSource, label: string | null, key: string) => {
      const video = byId.get(videoId);
      if (!video || !allowed(videoId)) return;
      const window = clipWindow(start, end, peak, video.durationSeconds);
      candidates.push({
        id: `${source}:${key}`,
        video_id: videoId,
        start_seconds: window.start,
        end_seconds: window.end,
        peak_seconds: window.peak,
        source,
        label,
      });
    };

    if (query.mode === "query" && query.query) {
      const found = await visualSearchService.search(userId, {
        query: query.query,
        filters: query.creatorId ? { creatorIds: [query.creatorId] } : {},
        limit: 120,
      });
      // Search order is the point here, so it is kept rather than shuffled.
      for (const result of found.results)
        for (const moment of result.moments.slice(0, 2))
          add(result.video_id, moment.start_seconds - 3, moment.end_seconds + 6, moment.peak_seconds, "visual", null, `${result.video_id}:${moment.peak_seconds}`);
    } else {
      if (query.mode !== "replayed") {
        for (const bookmark of await loadBookmarks(userId)) {
          const peak = bookmark.peak ?? bookmark.start;
          add(
            bookmark.videoId,
            bookmark.end === null ? bookmark.start - 2 : bookmark.start,
            bookmark.end ?? bookmark.start + 25,
            peak,
            "bookmark",
            bookmark.origin === "manual" ? bookmark.name : null,
            String(bookmark.id)
          );
        }
      }
      if (query.mode !== "bookmarks") {
        const durations = new Map(
          facts.videos.filter((video) => allowed(video.id)).map((video) => [video.id, video.durationSeconds])
        );
        for (const [videoId, found] of await watchHeatService.peaksFor(durations))
          for (const peak of found.slice(0, 2))
            add(videoId, peak.start_seconds, peak.end_seconds, peak.peak_seconds, "replayed", null, `${videoId}:${peak.peak_seconds}`);
      }
    }

    const ordered = query.mode === "query" ? candidates : spread(shuffle(candidates, seeded(query.seed)));
    const page = ordered.slice(query.offset, query.offset + query.limit);
    const videos = await hydrate(userId, page.map((item) => item.video_id));
    return {
      items: page,
      videos,
      total: ordered.length,
      next_offset: query.offset + query.limit < ordered.length ? query.offset + query.limit : null,
    };
  }
}

/** Keep two moments of the same video from landing back to back. */
export function spread(items: FeedMoment[]): FeedMoment[] {
  const out: FeedMoment[] = [];
  const pending = items.slice();
  while (pending.length) {
    const index = pending.findIndex((item) => item.video_id !== out[out.length - 1]?.video_id);
    out.push(...pending.splice(index === -1 ? 0 : index, 1));
  }
  return out;
}

export const discoveryService = new DiscoveryService();
