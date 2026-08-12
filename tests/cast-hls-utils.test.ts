import { describe, expect, it } from "bun:test";
import {
  calculateHlsBandwidth,
  getCastAssetKind,
  parseByteRange,
} from "@/modules/cast/cast-hls.utils";
import { sanitizeTelemetryUrl } from "@/utils/telemetry";

describe("Cast HLS helpers", () => {
  it("parses bounded, open, and suffix byte ranges", () => {
    expect(parseByteRange("bytes=10-19", 100)).toEqual({ start: 10, end: 19 });
    expect(parseByteRange("bytes=90-", 100)).toEqual({ start: 90, end: 99 });
    expect(parseByteRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
    expect(parseByteRange("bytes=90-200", 100)).toEqual({ start: 90, end: 99 });
  });

  it("rejects invalid or multiple ranges", () => {
    expect(parseByteRange("bytes=100-", 100)).toBeNull();
    expect(parseByteRange("bytes=20-10", 100)).toBeNull();
    expect(parseByteRange("bytes=0-1,4-5", 100)).toBeNull();
    expect(parseByteRange("items=0-1", 100)).toBeNull();
  });

  it("derives truthful average and peak bandwidth from completed segments", () => {
    const playlist = [
      "#EXTM3U",
      "#EXTINF:4.000000,",
      "segment-000000.ts",
      "#EXTINF:2.000000,",
      "segment-000001.ts",
      "#EXT-X-ENDLIST",
    ].join("\n");
    const result = calculateHlsBandwidth(
      playlist,
      new Map([
        ["segment-000000.ts", 4_000_000],
        ["segment-000001.ts", 3_000_000],
      ])
    );

    expect(result).toEqual({
      average: 9_333_334,
      peak: 12_600_000,
    });
  });

  it("classifies assets without exposing the session token", () => {
    expect(getCastAssetKind("master.m3u8")).toBe("manifest");
    expect(getCastAssetKind("init.mp4")).toBe("initialization");
    expect(getCastAssetKind("segment-000001.ts")).toBe("segment");
    expect(
      sanitizeTelemetryUrl(
        `/api/cast/${"a".repeat(64)}/segment-000001.ts?probe=1`
      )
    ).toBe("/api/cast/:token/segment-000001.ts");
  });
});
