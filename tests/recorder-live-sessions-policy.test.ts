import { describe, expect, test } from "bun:test";
import { buildEditFfmpegArgs } from "@/modules/edits/edits.processor";
import { mapEditGapsToSourceIntervals } from "@/modules/edits/edits.packet-validation";
import { validateEditRequest } from "@/modules/edits/edits.validation";
import {
  endedStatus,
  fileInSession,
  isStubRecording,
  liveEnded,
  orphanLives,
  recordedAtFromFileName,
  sampleSession,
  sessionTimeline,
  titleTags,
} from "@/modules/recordings/recordings.sessions.policy";

const at = (minutes: number) => new Date(Date.UTC(2026, 9, 12, 20, minutes));

describe("live sessions", () => {
  test("files made while Kura was away group into the lives they were", () => {
    const lives = orphanLives([
      { recordedAt: at(60), durationSeconds: 3600 },
      { recordedAt: at(0), durationSeconds: 3590 },
      { recordedAt: at(200), durationSeconds: 600 },
    ]);
    expect(lives).toEqual([
      { startedAt: at(0), lastStartAt: at(60) },
      { startedAt: at(200), lastStartAt: at(200) },
    ]);
  });

  test("reconnect stubs and files without a length are not waited on", () => {
    expect(isStubRecording(1.63)).toBe(true);
    expect(isStubRecording(null)).toBe(true);
    expect(isStubRecording(600)).toBe(false);
  });

  test("a minute online adds a viewer reading, and the title only when it changes", () => {
    const start = { startedAt: at(0), titles: [], viewers: [] as [number, number][], peakViewers: 0 };
    const first = sampleSession(start, { viewers: 120, title: "Goal: 500", now: at(0) });
    const second = sampleSession({ ...start, ...first }, { viewers: 300, title: "Goal: 500", now: at(1) });
    const third = sampleSession({ ...start, ...second }, { viewers: 0, title: " New goal ", now: at(2) });
    expect(third.viewers).toEqual([[0, 120], [60, 300]]);
    expect(third.titles.map((entry) => entry.title)).toEqual(["Goal: 500", "New goal"]);
    expect(third.peakViewers).toBe(300);
  });

  test("tags come from the titles' hashtags, once each", () => {
    expect(titleTags([{ title: "Goal: dance #Teen #squirt [50 left]" }, { title: "new #teen #ölçü #a" }])).toEqual(["teen", "squirt", "ölçü"]);
  });

  test("a live survives a short drop and ends after the grace period", () => {
    expect(liveEnded(at(0), false, at(5))).toBe(false);
    expect(liveEnded(at(0), true, at(30))).toBe(false);
    expect(liveEnded(at(0), false, at(10))).toBe(true);
    expect(endedStatus("highlights")).toBe("waiting");
    expect(endedStatus("whole")).toBe("kept");
  });

  test("files belong to the live of their channel that they started in", () => {
    const session = { username: "Alice", startedAt: at(10), lastSeenAt: at(50), endedAt: at(50) };
    expect(recordedAtFromFileName("alice_2026-10-12_20-12-00.mp4")).toEqual(at(12));
    expect(fileInSession("alice_2026-10-12_20-12-00.mp4", session)).toBe(true);
    expect(fileInSession("videos/stripchat/alice_2026-10-12_20-07-00.mp4", session)).toBe(true);
    expect(fileInSession("alice_2026-10-12_20-52-00.mp4", session)).toBe(false);
    expect(fileInSession("alicex_2026-10-12_20-12-00.mp4", session)).toBe(false);
    expect(fileInSession("alice_2026-10-12_19-50-00.mp4", session)).toBe(false);
  });

  test("the highlights timeline runs through the files in order, joining touching moments", () => {
    const segments = sessionTimeline([
      { videoId: 2, recordedAt: at(30), durationSeconds: 600, clips: [{ start_seconds: 590, end_seconds: 640 }] },
      {
        videoId: 1,
        recordedAt: at(0),
        durationSeconds: 1800,
        clips: [
          { start_seconds: 300, end_seconds: 400 },
          { start_seconds: 100, end_seconds: 200 },
          { start_seconds: 180, end_seconds: 250 },
        ],
      },
      { videoId: 3, recordedAt: at(40), durationSeconds: 600, clips: [] },
    ]);
    expect(segments).toEqual([
      { start: 100, end: 250, source_video_id: 1 },
      { start: 300, end: 400, source_video_id: 1 },
      { start: 590, end: 600, source_video_id: 2 },
    ]);
  });
});

describe("multi-source edits", () => {
  test("each segment reads its own file", () => {
    const args = buildEditFfmpegArgs({
      inputPath: "/rec/a.mp4",
      inputPaths: ["/rec/a.mp4", "/rec/b.mp4"],
      outputPath: "/out/h.mkv",
      timeline: { segments: [{ start: 1, end: 5 }, { start: 2, end: 6, source_video_id: 9 }] },
      output: { directory_id: 1, file_name: "h.mkv", format: "mkv", video_codec: "av1", audio_codec: "opus" },
      hasSourceAudio: true,
      vaapiDevice: "/dev/dri/renderD128",
      bitrate: "4M",
      maxrate: "5M",
      bufsize: "10M",
    });
    const inputs = args.flatMap((arg, index) => (arg === "-i" ? [args[index + 1]] : []));
    expect(inputs).toEqual(["/rec/a.mp4", "/rec/a.mp4", "/rec/b.mp4", "/rec/b.mp4"]);
  });

  test("segments are checked against their own source's length", () => {
    const output = { directory_id: 1, file_name: "h.mkv", format: "mkv", video_codec: "av1", audio_codec: "opus" } as const;
    const timeline = { segments: [{ start: 0, end: 50 }, { start: 0, end: 500, source_video_id: 9 }] };
    expect(() => validateEditRequest({ output, timeline }, 100, new Map([[9, 600]]))).not.toThrow();
    expect(() => validateEditRequest({ output, timeline }, 100, new Map([[9, 400]]))).toThrow("exceeds the source duration");
    expect(() => validateEditRequest({ output, timeline }, 100)).toThrow("unknown source video");
  });

  test("output holes map only into the segments of the source being checked", () => {
    const timeline = { segments: [{ start: 100, end: 110 }, { start: 0, end: 10, source_video_id: 9 }] };
    const gaps = [{ start: 2, end: 18 }];
    const all = mapEditGapsToSourceIntervals(gaps, timeline);
    const second = mapEditGapsToSourceIntervals(gaps, timeline, [], (index) => index === 1);
    expect(all.length).toBe(2);
    expect(second.length).toBe(1);
    expect(second[0]!.start).toBeLessThan(1);
  });
});
