import { describe, expect, it } from "bun:test";
import {
  extractCreatorFromPath,
  extractEpisodeFromPath,
  extractSeriesFromPath,
  extractStudioFromPath,
  extractTagsFromPath,
  parsePathWithPatterns,
  parseVideoPath,
} from "@/utils/path-parser";

describe("path parser", () => {
  it("extracts creator names from known platform folders", () => {
    const result = parseVideoPath("/media/OnlyFans/Ada Lovelace/clip_1080p.mp4");

    expect(result.fileName).toBe("clip_1080p.mp4");
    expect(result.extension).toBe("mp4");
    expect(result.parentDirectory).toBe("Ada Lovelace");
    expect(result.extracted.creator).toBe("Ada Lovelace");
    expect(result.confidence).toBe("high");
    expect(result.matchedPatterns).toEqual(["OnlyFans Creator Folder"]);
    expect(result.extracted.tags).toContain("1080P");
  });

  it("extracts studio and creator from nested studio folders", () => {
    const path = "/library/Studio One/Creator Two/video.webm";

    expect(extractStudioFromPath(path)).toBe("Studio One");
    expect(extractCreatorFromPath(path)).toBe("Creator Two");
  });

  it("extracts creator, series, and episode from series layouts", () => {
    const path = "/library/Creator/Series Name/Ep-07/final.mkv";
    const result = parseVideoPath(path);

    expect(result.extracted.creator).toBe("Creator");
    expect(result.extracted.series).toBe("Series Name");
    expect(result.extracted.episode).toBe("07");
    expect(extractSeriesFromPath(path)).toBe("Series Name");
    expect(extractEpisodeFromPath(path)).toBe("07");
  });

  it("extracts filename tags when no pattern supplied tags", () => {
    const tags = extractTagsFromPath("/videos/misc/my_video_4k_hdr_vr.mp4");

    expect(tags).toEqual(["4K", "HDR", "VR"]);
  });

  it("supports custom named capture groups and ignores invalid patterns", () => {
    const result = parseVideoPath("/vault/2026/artist-name/file.mp4", {
      patterns: [
        {
          name: "Year Artist",
          pattern: "/vault/(?<year>\\d{4})/(?<artist>[^/]+)/",
          confidence: "medium",
        },
      ],
      customGroups: ["year", "artist"],
    });

    expect(result.confidence).toBe("medium");
    expect(result.extracted.custom).toEqual({
      year: "2026",
      artist: "artist-name",
    });

    expect(
      parsePathWithPatterns("/videos/source/file.mp4", [
        { pattern: "/videos/(?<source>[^/]+)/", group: "source" },
        { pattern: "(", group: "invalid" },
      ]),
    ).toEqual({
      source: "source",
      invalid: null,
    });
  });
});
