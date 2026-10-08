import { describe, expect, test } from "bun:test";
import { channelNeed, mixedSignal, trainingValues } from "@/modules/recordings/recordings.training-value";

const clips = (...keeps: boolean[]) => keeps.map((keep) => ({ keep }));
const candidate = (videoId: number, keeps: boolean[] | null, channel: string | null = `c${videoId}`) => ({
  videoId,
  status: keeps ? "proposed" : "pending",
  clips: keeps ? clips(...keeps) : null,
  channel,
});

describe("training value", () => {
  test("a kept and a skipped highlight beat several of one kind, which beat a single one", () => {
    expect(mixedSignal(clips(true, false))).toBeGreaterThan(mixedSignal(clips(true, true, true)));
    expect(mixedSignal(clips(true, true))).toBeGreaterThan(mixedSignal(clips(true)));
    expect(mixedSignal(clips())).toBe(0);
  });

  test("a channel that has given enough counts less", () => {
    expect(channelNeed(0, 4, true)).toBe(1);
    expect(channelNeed(4, 4, true)).toBeCloseTo(0.4);
    expect(channelNeed(9, 4, true)).toBeCloseTo(0.4);
  });

  test("recordings from one channel spread out instead of filling the top", () => {
    const values = trainingValues(
      [candidate(1, [true, false], "a"), candidate(2, [true, false], "a"), candidate(3, [true, false], "b")],
      new Map(),
      4
    );
    expect(values.get(1)).toBeGreaterThan(values.get(2)!);
    expect(values.get(3)).toBe(values.get(1));
  });

  test("a mixed recording from a finished channel still beats a single highlight from a fresh one", () => {
    const values = trainingValues([candidate(1, [true, false], "done"), candidate(2, [true], "fresh")], new Map([["done", 4]]), 4);
    expect(values.get(1)).toBeGreaterThan(values.get(2)!);
  });
});

test("a long list of highlights ranks below a short mixed one", () => {
  expect(mixedSignal(clips(true, false, false))).toBeGreaterThan(mixedSignal(clips(true, ...Array<boolean>(20).fill(false))));
});
