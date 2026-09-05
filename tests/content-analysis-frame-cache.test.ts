import { expect, it } from "bun:test";
import { RefinementFrameCache } from "@/modules/content-analysis/content-analysis.frame-cache";

const frames = (start: number, count = 3) =>
  Array.from({ length: count }, (_, index) => ({
    index,
    ptsSeconds: start + index,
    image: new Blob(["1234"], { type: "image/jpeg" }),
  }));

it("reuses only the exact sampling origin and interval, including empty windows", () => {
  const cache = new RefinementFrameCache(100);
  cache.put(0, 3, 1, frames(0));
  expect(cache.take(0.1, 3, 1)).toBeUndefined();
  expect(cache.take(0, 3, 0.5)).toBeUndefined();
  expect(cache.take(0, 4, 1)).toBeUndefined();
  expect(cache.take(0, 1.5, 1)?.map((frame) => frame.ptsSeconds)).toEqual([
    0, 1,
  ]);
  expect(cache.byteSize).toBe(0);
  expect(cache.take(0, 3, 1)).toBeUndefined();
  cache.put(3, 6, 1, []);
  expect(cache.take(3, 6, 1)).toEqual([]);
});

it("evicts complete windows within the byte budget and supports disabling the cache", () => {
  const cache = new RefinementFrameCache(16);
  cache.put(0, 3, 1, frames(0));
  cache.put(3, 6, 1, frames(3));
  expect(cache.byteSize).toBe(12);
  expect(cache.take(0, 3, 1)).toBeUndefined();
  cache.put(6, 11, 1, frames(6, 5));
  expect(cache.size).toBe(1);
  expect(cache.take(3, 6, 1)).toHaveLength(3);
  const disabled = new RefinementFrameCache(0);
  disabled.put(0, 3, 1, frames(0));
  expect(disabled.size).toBe(0);
  expect(() => new RefinementFrameCache(Number.NaN)).toThrow();
});
