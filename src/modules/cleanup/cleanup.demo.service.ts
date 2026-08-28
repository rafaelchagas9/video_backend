import { demoMockService } from "@/utils/demo-mock";
import { ConflictError } from "@/utils/errors";
import type {
  CleanupCandidate,
  CleanupDisposition,
  CleanupOverview,
} from "./cleanup.types";

type DemoReview = {
  disposition: "keep" | "delete" | "later";
  revision: number;
  reviewedAt: string;
  firstReviewedAt: string;
};
const reviews = new Map<string, DemoReview>();
const key = (userId: number, videoId: number) => `${userId}:${videoId}`;

class CleanupDemoService {
  async listCandidates(
    userId: number,
    options: { disposition: CleanupDisposition; limit: number; offset: number }
  ) {
    const videos = demoMockService.getVideos({ limit: 100 }).data;
    const mapped: CleanupCandidate[] = videos
      .map((video) => {
        const review = reviews.get(key(userId, video.id));
        const disposition: CleanupDisposition =
          review?.disposition ?? "unreviewed";
        return {
          id: video.id,
          title: video.title,
          file_name: video.file_name,
          file_size_bytes: video.file_size_bytes,
          duration_seconds: video.duration_seconds,
          indexed_at: video.indexed_at,
          codec: video.codec,
          bitrate: video.bitrate,
          thumbnail_url: video.thumbnail_url,
          creators:
            video.creators?.map((creator: { id: number; name: string }) => ({
              id: creator.id,
              name: creator.name,
            })) ?? [],
          engagement: {
            play_count: 0,
            total_watch_seconds: 0,
            watched_fraction: 0,
            last_watched_at: null,
          },
          protections: {
            favorite: false,
            favorited_creator: false,
            high_rating: false,
            bookmark: false,
            playlist: false,
            collection: false,
            active_job: false,
          },
          reasons: ["large file", "older than 30 days", "not watched"],
          eligible: true,
          disposition,
          revision: review?.revision ?? 0,
          reviewed_at: review?.reviewedAt ?? null,
        };
      })
      .filter((item) => item.disposition === options.disposition)
      .sort((a, b) => b.file_size_bytes - a.file_size_bytes);
    return {
      data: mapped.slice(options.offset, options.offset + options.limit),
      total: mapped.length,
    };
  }
  async overview(userId: number): Promise<CleanupOverview> {
    const unreviewed = await this.listCandidates(userId, {
      disposition: "unreviewed",
      limit: 100,
      offset: 0,
    });
    const videos = demoMockService.getVideos({ limit: 100 }).data;
    const videoBytes = new Map(
      videos.map((video) => [video.id, video.file_size_bytes])
    );
    const bytesForEntries = (items: Array<[string, DemoReview]>) =>
      items.reduce((total, [entryKey]) => {
        const videoId = Number(entryKey.slice(entryKey.indexOf(":") + 1));
        return total + (videoBytes.get(videoId) ?? 0);
      }, 0);
    const decided = (["keep", "delete", "later"] as const).map(
      (disposition) => ({
        disposition,
        items: [...reviews.entries()].filter(
          ([entryKey, value]) =>
            entryKey.startsWith(`${userId}:`) &&
            value.disposition === disposition
        ),
      })
    );
    const activityMap = new Map<string, { count: number; bytes: number }>();
    for (const [entryKey, review] of reviews) {
      if (!entryKey.startsWith(`${userId}:`)) continue;
      const date = review.firstReviewedAt.slice(0, 10);
      const videoId = Number(entryKey.slice(entryKey.indexOf(":") + 1));
      const current = activityMap.get(date) ?? { count: 0, bytes: 0 };
      activityMap.set(date, {
        count: current.count + 1,
        bytes: current.bytes + (videoBytes.get(videoId) ?? 0),
      });
    }
    const activity = [...activityMap].map(([date, totals]) => ({
      date,
      count: totals.count,
      bytes: totals.bytes,
    }));
    const countFor = (d: "keep" | "delete" | "later") =>
      decided.find((entry) => entry.disposition === d)?.items.length ?? 0;
    const bytesFor = (d: "keep" | "delete" | "later") =>
      bytesForEntries(
        decided.find((entry) => entry.disposition === d)?.items ?? []
      );
    const reviewed = countFor("keep") + countFor("delete") + countFor("later");
    const reviewedBytes =
      bytesFor("keep") + bytesFor("delete") + bytesFor("later");
    const libraryBytes = videos.reduce(
      (total, video) => total + video.file_size_bytes,
      0
    );
    return {
      policy: {
        min_age_days: 30,
        max_watch_seconds: 300,
        max_watch_fraction: 0.1,
      },
      library: {
        count: videos.length,
        bytes: libraryBytes,
      },
      quick_wins: {
        count: videos.length,
        bytes: libraryBytes,
        unreviewed_count: unreviewed.total,
        unreviewed_bytes: unreviewed.data.reduce(
          (total, video) => total + video.file_size_bytes,
          0
        ),
      },
      decisions: {
        keep: {
          count: countFor("keep"),
          bytes: bytesFor("keep"),
        },
        delete: {
          count: countFor("delete"),
          bytes: bytesFor("delete"),
        },
        later: {
          count: countFor("later"),
          bytes: bytesFor("later"),
        },
      },
      rewards: {
        reviewed_count: reviewed,
        reviewed_bytes: reviewedBytes,
        today_count:
          activity.find(
            (item) => item.date === new Date().toISOString().slice(0, 10)
          )?.count ?? 0,
        daily_goal: 10,
        streak_days: activity.length ? 1 : 0,
        activity,
      },
    };
  }
  async saveReview(
    userId: number,
    videoId: number,
    disposition: CleanupDisposition,
    expectedRevision: number
  ) {
    const current = reviews.get(key(userId, videoId));
    const revision = current?.revision ?? 0;
    if (revision !== expectedRevision)
      throw new ConflictError("Cleanup decision changed on another device");
    if (disposition === "unreviewed") {
      reviews.delete(key(userId, videoId));
      return {
        video_id: videoId,
        disposition,
        revision: 0,
        reviewed_at: null,
      };
    }
    const now = new Date().toISOString();
    const saved = {
      disposition,
      revision: revision + 1,
      reviewedAt: now,
      firstReviewedAt: current?.firstReviewedAt ?? now,
    };
    reviews.set(key(userId, videoId), saved);
    return {
      video_id: videoId,
      disposition,
      revision: saved.revision,
      reviewed_at: now,
    };
  }
}
export const cleanupDemoService = new CleanupDemoService();
