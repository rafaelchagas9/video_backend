import { describe, expect, it } from "bun:test";
import { buildGuide, capturedAt, guideItem, type ChannelHistory, type GuideQueueInput } from "@/modules/recordings/recordings.guide.policy";

const item = (over: Partial<GuideQueueInput>): GuideQueueInput => ({
  videoId: 1, fileName: "someone_2026-10-20_10-00-00.mp4", title: null, durationSeconds: 3600, channel: "someone", library: false, status: "proposed", ...over,
});
const seen = (recordings: number, highlightRecordings = 0, keeps = 0): ChannelHistory => ({ recordings, highlightRecordings, keeps });

describe("review guide", () => {
  it("reads GoondVR's UTC capture time from the file name", () => {
    expect(capturedAt("a_b_2026-10-22_03-26-01_2.mp4")?.toISOString()).toBe("2026-10-22T03:26:01.000Z");
    expect(capturedAt("Some download.mp4")).toBeNull();
  });

  it("deletes fragments and skips edited compilations before anything else", () => {
    expect(guideItem(item({ durationSeconds: 300 }), new Map()).action).toBe("delete");
    expect(guideItem(item({ library: true, channel: null, fileName: "cb-x-26-08-02-highlights.mkv" }), new Map()).action).toBe("skip");
  });

  it("ranks channels with history first, then downloads, then new channels; capture time only warns", () => {
    const history = new Map([["known", seen(2)]]);
    const synced = guideItem(item({ fileName: "new_2026-10-23_10-00-00.mp4", channel: "new" }), history);
    const repeat = guideItem(item({ channel: "known" }), history);
    const download = guideItem(item({ library: true, channel: null, fileName: "full stream.mp4" }), history);
    const first = guideItem(item({ channel: "new" }), history);
    expect([repeat, download, first].map((entry) => entry.priority)).toEqual([2, 3, 4]);
    expect(synced.priority).toBe(first.priority);
    expect(synced.warnings).toEqual([]);
    expect(repeat.warnings).toEqual(["desync"]);
    expect(download.warnings).toEqual([]);
  });

  it("calls a channel enough by its precise reviews, not by broad ones", () => {
    expect(guideItem(item({ channel: "broad" }), new Map([["broad", seen(9, 0)]])).action).toBe("review");
    expect(guideItem(item({ channel: "done" }), new Map([["done", seen(9, 6)]])).action).toBe("optional");
    expect(guideItem(item({ channel: "huge" }), new Map([["huge", seen(22, 1)]])).action).toBe("optional");
  });

  it("names channels to record more, enough of, and where nothing was ever kept", () => {
    const history = new Map([["few", seen(2, 2, 5)], ["lots", seen(22, 3, 20)], ["dull", seen(4, 0, 0)]]);
    const looks = new Map([["few", { creatorId: 7, hasPicture: false, channelId: "chaturbate__few" }], ["lots", { creatorId: 9, hasPicture: true, channelId: null }]]);
    const guide = buildGuide([], history, { highlightRecordings: 28, highlightChannels: 11, wholeStreams: 3, worthOpen: 134 }, looks);
    expect(guide.record_more.map((entry) => entry.channel)).toEqual(["few"]);
    expect(guide.enough.map((entry) => entry.channel)).toEqual(["lots"]);
    expect(guide.nothing_kept.map((entry) => entry.channel)).toEqual(["dull"]);
    expect(guide.progress.highlight_recordings).toEqual({ done: 28, target: 60 });
    // A creator's own picture wins; without one, GoondVR's profile image; without either, none.
    expect(guide.enough[0]?.picture).toBe("creator");
    expect(guide.record_more[0]?.picture).toBe("channel");
    expect(guide.nothing_kept[0]?.picture).toBeNull();
  });
});
