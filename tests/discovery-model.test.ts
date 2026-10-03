import { describe, expect, it } from "bun:test";
import { affinities, buildRediscovery } from "@/modules/discovery/discovery.model";
import type { CreatorTaste, VideoFact } from "@/modules/discovery/discovery.source";

const now = new Date("2026-10-03T12:00:00Z");
const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000);

function video(id: number, creatorIds: number[], extra: Partial<VideoFact> = {}): VideoFact {
  return {
    id,
    durationSeconds: 1200,
    createdAt: daysAgo(400),
    creatorIds,
    playCount: 0,
    watchSeconds: 0,
    lastWatchedAt: null,
    ...extra,
  };
}

describe("affinities", () => {
  it("lets recent watching outrank older watching of equal volume", () => {
    const tastes: CreatorTaste[] = [
      { creatorId: 1, name: "Old", watchSeconds: 3600, plays: 10, lastWatchedAt: daysAgo(300) },
      { creatorId: 2, name: "Recent", watchSeconds: 3600, plays: 10, lastWatchedAt: daysAgo(2) },
    ];
    const ranked = affinities(tastes, now);
    expect(ranked.map((affinity) => affinity.name)).toEqual(["Recent", "Old"]);
    expect(ranked[0]!.lifetime).toBe(ranked[1]!.lifetime);
  });
});

describe("rediscovery", () => {
  const videos = [
    video(1, [1], { playCount: 3, watchSeconds: 900, lastWatchedAt: daysAgo(3) }),
    ...Array.from({ length: 6 }, (_, i) => video(10 + i, [1])),
    video(20, [2], { playCount: 5, watchSeconds: 2000, lastWatchedAt: daysAgo(120) }),
    ...Array.from({ length: 5 }, (_, i) => video(30 + i, [2])),
    ...Array.from({ length: 12 }, (_, i) => video(40 + i, [3])),
  ];
  const tastes: CreatorTaste[] = [
    { creatorId: 1, name: "Ana", watchSeconds: 900, plays: 3, lastWatchedAt: daysAgo(3) },
    { creatorId: 2, name: "Bia", watchSeconds: 2000, plays: 5, lastWatchedAt: daysAgo(120) },
  ];
  const sections = buildRediscovery({
    videos,
    tastes,
    peaks: new Map([[20, [{ start_seconds: 300, end_seconds: 340, peak_seconds: 320, intensity: 1 }]]]),
    now,
    seed: "2026-10-03",
    creatorNames: new Map([[1, "Ana"], [2, "Bia"], [3, "Cris"]]),
  });
  const byId = new Map(sections.map((section) => [section.id, section]));

  it("surfaces only never-played videos from watched creators", () => {
    const items = byId.get("unseen-favorites")!.items;
    expect(items.length).toBeGreaterThanOrEqual(3);
    for (const item of items) expect(videos.find((v) => v.id === item.video_id)!.playCount).toBe(0);
  });

  it("does not repeat a video across sections", () => {
    const all = sections.flatMap((section) => section.items.map((item) => item.video_id));
    expect(new Set(all).size).toBe(all.length);
  });

  it("flags large untouched catalogues", () => {
    expect(byId.get("barely-explored")!.items[0]!.reason).toContain("Cris · 0 of 12 watched");
  });

  it("is stable for a seed", () => {
    const again = buildRediscovery({
      videos,
      tastes,
      peaks: new Map(),
      now,
      seed: "2026-10-03",
      creatorNames: new Map([[1, "Ana"], [2, "Bia"], [3, "Cris"]]),
    });
    expect(again.find((s) => s.id === "unseen-favorites")!.items).toEqual(byId.get("unseen-favorites")!.items);
  });
});

describe("rediscovery with shared videos", () => {
  it("never lists a video twice in one section when several of its creators qualify", () => {
    // Video 7 is the most-watched for both quiet creators, so both would pick it.
    const videos = [video(7, [1, 2], { playCount: 4, watchSeconds: 5000, lastWatchedAt: daysAgo(90) })];
    const tastes: CreatorTaste[] = [
      { creatorId: 1, name: "Ana", watchSeconds: 5000, plays: 4, lastWatchedAt: daysAgo(90) },
      { creatorId: 2, name: "Bia", watchSeconds: 5000, plays: 4, lastWatchedAt: daysAgo(90) },
    ];
    const sections = buildRediscovery({ videos, tastes, peaks: new Map(), now, seed: "s", creatorNames: new Map() });
    for (const section of sections) {
      const ids = section.items.map((item) => item.video_id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});
