import { expect, it } from "bun:test";
import { isVideoWatched } from "@/modules/video-stats/video-watch-state";

it("recognizes manually completed progress without inventing a counted play", () => {
  expect(
    isVideoWatched({ playCount: 0, positionSeconds: 100, durationSeconds: 100 })
  ).toBe(true);
  expect(
    isVideoWatched({ playCount: 0, positionSeconds: 95, durationSeconds: 100 })
  ).toBe(true);
  expect(
    isVideoWatched({ playCount: 3, positionSeconds: 94, durationSeconds: 100 })
  ).toBe(false);
});
it("does not mark absent, cleared, or invalid progress as watched", () => {
  for (const positionSeconds of [undefined, null, -1]) {
    expect(
      isVideoWatched({ playCount: 3, positionSeconds, durationSeconds: 100 })
    ).toBe(false);
  }
  for (const durationSeconds of [undefined, null, 0, -1]) {
    expect(
      isVideoWatched({ playCount: 0, positionSeconds: 100, durationSeconds })
    ).toBe(false);
  }
});
it("recognizes players resetting completed progress to zero only after a counted play", () => {
  expect(
    isVideoWatched({ playCount: 1, positionSeconds: 0, durationSeconds: 100 })
  ).toBe(true);
  for (const playCount of [undefined, null, 0]) {
    expect(
      isVideoWatched({ playCount, positionSeconds: 0, durationSeconds: 100 })
    ).toBe(false);
  }
});
