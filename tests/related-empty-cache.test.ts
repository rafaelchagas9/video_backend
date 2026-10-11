import { describe, expect, it } from "bun:test";
import { RelatedEmptyCache } from "@/modules/videos/related-empty-cache";

describe("empty recommendation cache", () => {
  it("separates users and sources and expires empty results", () => {
    const cache = new RelatedEmptyCache(100, 3);
    cache.remember(1, 10, 1000);
    expect(cache.get(1, 10, 1099)?.getTime()).toBe(1000);
    expect(cache.get(2, 10, 1099)).toBeNull();
    expect(cache.get(1, 11, 1099)).toBeNull();
    expect(cache.get(1, 10, 1100)).toBeNull();
  });
  it("evicts the oldest entry to keep memory bounded", () => {
    const cache = new RelatedEmptyCache(100, 2);
    cache.remember(1, 10, 1000);
    cache.remember(1, 11, 1001);
    cache.remember(1, 12, 1002);
    expect(cache.get(1, 10, 1003)).toBeNull();
    expect(cache.get(1, 11, 1003)?.getTime()).toBe(1001);
    expect(cache.get(1, 12, 1003)?.getTime()).toBe(1002);
  });
  it("clears negative results after changes and forgets a refreshed source", () => {
    const cache = new RelatedEmptyCache();
    cache.remember(1, 10, 1000);
    cache.remember(1, 11, 1000);
    cache.forget(1, 10);
    expect(cache.get(1, 10, 1001)).toBeNull();
    expect(cache.get(1, 11, 1001)).not.toBeNull();
    cache.clear();
    expect(cache.get(1, 11, 1001)).toBeNull();
  });
  it("does not repopulate an invalidated cache when an older refresh finishes", async () => {
    const cache = new RelatedEmptyCache();
    const generation = cache.generation;
    let finishRefresh!: () => void;
    const pendingRefresh = new Promise<void>((resolve) => { finishRefresh = resolve; })
      .then(() => cache.remember(1, 10, 1000, generation));
    // Metadata changes while the first refresh awaits its database transaction.
    cache.clear();
    const newGeneration = cache.generation;
    cache.remember(1, 11, 1001, newGeneration);
    finishRefresh();
    await pendingRefresh;
    expect(cache.get(1, 10, 1002)).toBeNull();
    expect(cache.get(1, 11, 1002)?.getTime()).toBe(1001);
    // A fresh computation for the same source can still populate the cache.
    cache.remember(1, 10, 1003, newGeneration);
    expect(cache.get(1, 10, 1004)?.getTime()).toBe(1003);
  });

});
