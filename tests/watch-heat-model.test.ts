import { describe, expect, it } from "bun:test";
import { addPass, curve, peaks } from "@/modules/discovery/watch-heat.model";

describe("watch heat", () => {
  it("adds fractional coverage per bucket", () => {
    expect(addPass([], 2.5, 12.5, 5)).toEqual([0.5, 1, 0.5]);
  });

  it("ignores empty and negative passes", () => {
    expect(addPass([1], 10, 10, 5)).toEqual([1]);
    expect(addPass([1], -3, 4, 5)).toEqual([1]);
  });

  it("finds the stretch a viewer keeps returning to", () => {
    let buckets: number[] = [];
    buckets = addPass(buckets, 0, 600); // one full watch of a 10-minute video
    for (let replay = 0; replay < 4; replay++) buckets = addPass(buckets, 300, 340);
    const found = peaks(buckets, 600);
    expect(found).toHaveLength(1);
    expect(found[0]!.start_seconds).toBeGreaterThanOrEqual(285);
    expect(found[0]!.end_seconds).toBeLessThanOrEqual(355);
    expect(found[0]!.peak_seconds).toBeGreaterThan(300);
    expect(found[0]!.peak_seconds).toBeLessThan(340);
  });

  it("reports no peak for an evenly watched video", () => {
    expect(peaks(addPass([], 0, 600), 600)).toEqual([]);
  });

  it("normalises the curve to its maximum", () => {
    const values = curve(addPass(addPass([], 0, 100), 40, 60), 100);
    expect(Math.max(...values)).toBe(1);
    expect(values.length).toBe(20);
  });
});
