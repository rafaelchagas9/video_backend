import { describe, expect, test } from "bun:test";
import { livePlaylist } from "@/modules/recordings/recordings.demo-live";

const prepared = { dir: "/unused", durations: [4, 4, 4, 4, 4, 4, 4, 4, 4, 4], total: 40 };

function parse(text: string) {
  const lines = text.trim().split("\n");
  const value = (tag: string) => Number(lines.find((line) => line.startsWith(tag))!.slice(tag.length));
  const segments = lines.filter((line) => line.startsWith("seg-")).map((line) => Number(line.slice(4, -4)));
  return {
    sequence: value("#EXT-X-MEDIA-SEQUENCE:"),
    discontinuitySequence: value("#EXT-X-DISCONTINUITY-SEQUENCE:"),
    discontinuities: lines.filter((line) => line === "#EXT-X-DISCONTINUITY").length,
    segments,
  };
}

describe("demo live playlist", () => {
  test("holds a window as long as GoondVR's, looping the source", () => {
    const playlist = parse(livePlaylist("chaturbate__someone", prepared, 1_800_000_000_000));
    // 120 s of 4 s segments.
    expect(playlist.segments).toHaveLength(30);
    expect(playlist.segments[0]).toBe(playlist.sequence);
    expect(playlist.segments.every((value, index) => index === 0 || value === playlist.segments[index - 1]! + 1)).toBe(true);
    // A 40 s source loops three times inside a 120 s window.
    expect(playlist.discontinuities).toBeGreaterThanOrEqual(2);
    expect(playlist.discontinuitySequence).toBe(Math.floor(playlist.sequence / prepared.durations.length));
  });

  test("slides with the clock: four seconds later, one segment on", () => {
    const now = 1_800_000_000_000;
    const before = parse(livePlaylist("chaturbate__someone", prepared, now));
    const after = parse(livePlaylist("chaturbate__someone", prepared, now + 4_000));
    expect(after.sequence).toBe(before.sequence + 1);
  });

  test("channels sharing a stand-in are not in lockstep", () => {
    const now = 1_800_000_000_000;
    const a = parse(livePlaylist("chaturbate__one", prepared, now));
    const b = parse(livePlaylist("chaturbate__two", prepared, now));
    expect(a.sequence % 10 === b.sequence % 10 && a.sequence === b.sequence).toBe(false);
  });
});
