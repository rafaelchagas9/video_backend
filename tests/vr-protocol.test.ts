import { describe, it, expect } from "bun:test";
import {
  issueVrToken,
  verifyVrToken,
  projectionFor,
  hereVideo,
  deoVideo,
  groupByCreator,
} from "../src/modules/vr/vr.protocol";
import type { Video } from "../src/modules/videos/videos.types";
const video = {
  id: 7,
  file_name: "sample.mp4",
  title: "Sample",
  description: null,
  duration_seconds: 12.25,
  width: 1920,
  height: 1080,
  file_size_bytes: 1000,
  created_at: "2026-10-01",
  is_favorite: true,
  creators: [{ id: 1, name: "Creator A" }],
  tags: [],
} as unknown as Video;
describe("VR player protocol contracts", () => {
  it("leases survive restarts, enforce signature and expiry", () => {
    const token = issueVrToken(42, "secret", 1000);
    expect(verifyVrToken(token, "secret", 1001)?.userId).toBe(42);
    expect(verifyVrToken(token, "different", 1001)).toBeNull();
    expect(verifyVrToken(token + "x", "secret", 1001)).toBeNull();
    expect(verifyVrToken(token, "secret", 1000 + 30 * 86400000)).toBeNull();
  });
  it("uses explicit projection over filenames and leaves ordinary files flat", () => {
    expect(projectionFor(video)).toEqual({
      screenType: "flat",
      stereoMode: "off",
      fov: 90,
      lens: "Linear",
    });
    expect(projectionFor({ file_name: "film_SBS_180.mp4" })).toEqual({
      screenType: "dome",
      stereoMode: "sbs",
      fov: 180,
      lens: "Linear",
    });
    expect(
      projectionFor({ file_name: "film_SBS_180.mp4" }, [
        { key: "vr.projection", value: "sphere" },
        { key: "vr.stereo", value: "off" },
      ])
    ).toEqual({
      screenType: "sphere",
      stereoMode: "off",
      fov: 360,
      lens: "Linear",
    });
  });
  it("HereSphere requires milliseconds, media sources and creator tags; writes disabled", () => {
    const out = hereVideo(video, "https://kura/api/vr", "lease");
    expect(out.duration).toBe(12250);
    expect(out.projection).toBe("perspective");
    expect(out.stereo).toBe("mono");
    expect(out.tags).toContainEqual({ name: "Talent:Creator A" });
    expect(out.media[0].sources[0].url).toBe(
      "https://kura/api/vr/stream/7?token=lease"
    );
    expect(out.writeHSP).toBe(false);
  });
  it("DeoVR uses seconds and encodings; groups shared creators without losing membership", () => {
    expect(deoVideo(video, "https://kura/api/vr", "lease").videoLength).toBe(
      12.25
    );
    expect(
      groupByCreator([
        video,
        {
          ...video,
          id: 8,
          creators: [...video.creators!, { id: 2, name: "Creator B" } as never],
        },
      ]).map(([name, list]) => [name, list.length])
    ).toEqual([
      ["Creator A", 2],
      ["Creator B", 1],
    ]);
  });
});
