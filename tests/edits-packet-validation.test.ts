import { expect, it } from "bun:test";
import {
  VideoPacketCoverage,
  mapEditGapsToSourceIntervals,
} from "@/modules/edits/edits.packet-validation";

it("detects the reported frozen middle even with valid beginning and end timestamps", () => {
  const coverage = new VideoPacketCoverage();
  for (let t = 0; t <= 568; t += 0.5) coverage.add(t);
  coverage.add(568.283);
  for (let t = 1751.68; t < 2173; t += 0.5) coverage.add(t);
  expect(coverage.gaps(2173.02)).toEqual([{ start: 568.283, end: 1751.68 }]);
});

it("merges delayed and duplicate timestamps instead of inventing gaps", () => {
  const coverage = new VideoPacketCoverage();
  for (const timestamp of [0, 0, 3, 2, 1, 1, 5, 4]) coverage.add(timestamp);
  expect(coverage.gaps(5.1)).toEqual([]);
});

it("checks missing video at the beginning and end", () => {
  const coverage = new VideoPacketCoverage();
  coverage.add(3);
  coverage.add(4);
  expect(coverage.gaps(8)).toEqual([
    { start: 0, end: 3 },
    { start: 4, end: 8 },
  ]);
});

it("maps a gap across reordered selections and different playback speeds", () => {
  expect(
    mapEditGapsToSourceIntervals([{ start: 1, end: 4 }], {
      segments: [
        { start: 100, end: 106, speed: 2 },
        { start: 10, end: 12, speed: 0.5 },
      ],
    })
  ).toEqual([
    { start: 10, end: 10.375 },
    { start: 102.5, end: 106 },
  ]);
});

it("maps a gap from where a late seek really started the segment", () => {
  // The seek to 2914 decoded its first frame 1.43 s later, so the output hole at
  // 30.76 s is the source's own dropout at 2946.16 s, not frames the render lost.
  const [interval] = mapEditGapsToSourceIntervals(
    [{ start: 30.76, end: 34.12 }],
    { segments: [{ start: 2914, end: 3004 }] },
    [1.43]
  );
  expect(interval!.start).toBeCloseTo(2946.44, 6);
  expect(interval!.end).toBeCloseTo(2949.3, 6);
});
