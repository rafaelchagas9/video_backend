import { describe, expect, test } from "bun:test";
import {
  DEFAULT_AUTOPILOT_SETTINGS as settings,
  channelHistory,
  liveTransition,
  settledState,
  targetReached,
  type LiveInput,
} from "@/modules/recordings/recordings.autopilot.policy";

const at = (minutes: number) => new Date(Date.UTC(2026, 9, 7, 12, minutes));
const outcome = (clips: number, kept: number, skipped: number, minutes: number) => ({ status: "done", clips, kept, skipped, recordedAt: at(minutes) });
const live = (input: Partial<LiveInput>): LiveInput => ({
  state: "watching",
  stateSince: at(0),
  online: true,
  hotStreak: 0,
  lastHotAt: null,
  title: "",
  blocked: null,
  now: at(60),
  ...input,
});

describe("channel history", () => {
  test("counts the latest empty recordings in a row", () => {
    const history = channelHistory([outcome(2, 1, 1, 1), outcome(0, 0, 0, 2), outcome(0, 0, 0, 3)]);
    expect(history.emptyStreak).toBe(2);
    expect(history.useful).toBe(1);
  });

  test("a channel with enough useful recordings is retired", () => {
    const history = channelHistory([1, 2, 3, 4].map((m) => outcome(3, 1, 2, m)));
    expect(settledState(history, settings)?.state).toBe("enough");
  });

  test("three empty recordings in a row drop a channel", () => {
    const history = channelHistory([outcome(3, 1, 2, 1), ...[2, 3, 4].map((m) => outcome(0, 0, 0, m))]);
    expect(settledState(history, settings)?.state).toBe("dropped");
  });

  test("reviewed recordings that never kept anything drop a channel", () => {
    const history = channelHistory([1, 2, 3].map((m) => outcome(2, 0, 2, m)));
    expect(settledState(history, settings)?.state).toBe("dropped");
  });

  test("a new channel settles nothing", () => {
    expect(settledState(channelHistory([]), settings)).toBeNull();
  });
});

describe("live transitions", () => {
  test("starts after two hot readings in a row", () => {
    expect(liveTransition(live({ hotStreak: 1 }), settings)).toBeNull();
    expect(liveTransition(live({ hotStreak: 2 }), settings)?.state).toBe("recording");
  });

  test("a preferred title starts on one reading, a blocked one never", () => {
    const prefer = { ...settings, titlePrefer: ["squirt"], titleBlock: ["ticket"] };
    expect(liveTransition(live({ hotStreak: 1, title: "SQUIRT at goal" }), prefer)?.state).toBe("recording");
    expect(liveTransition(live({ hotStreak: 5, title: "ticket show" }), prefer)).toBeNull();
  });

  test("never starts while blocked or offline", () => {
    expect(liveTransition(live({ hotStreak: 5, blocked: "queue" }), settings)).toBeNull();
    expect(liveTransition(live({ hotStreak: 5, online: false }), settings)).toBeNull();
  });

  test("stops after the idle stretch, but not before the minimum length", () => {
    const recording = { state: "recording" as const, stateSince: at(0) };
    expect(liveTransition(live({ ...recording, lastHotAt: at(45), now: at(60) }), settings)).toBeNull();
    expect(liveTransition(live({ ...recording, lastHotAt: at(30), now: at(60) }), settings)?.state).toBe("watching");
    expect(liveTransition(live({ ...recording, stateSince: at(50), lastHotAt: null, now: at(60) }), settings)).toBeNull();
  });

});

test("the target needs all three numbers", () => {
  expect(targetReached({ pairedRecordings: 60, channels: 25, keeps: 149 }, settings.targets)).toBe(false);
  expect(targetReached({ pairedRecordings: 60, channels: 25, keeps: 150 }, settings.targets)).toBe(true);
});
