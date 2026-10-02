import { describe, expect, test } from "bun:test";
import { projectionFor, hereVideo, deoVideo } from "@/modules/vr/vr.protocol";
import type { Video } from "@/modules/videos/videos.types";
const base = {
  id: 1,
  title: null,
  description: null,
  duration_seconds: 60.5,
  width: 7680,
  height: 3840,
  file_size_bytes: 123456789,
  created_at: "2026-10-01",
  creators: [],
  tags: [],
  codec: "hevc",
} as unknown as Video;
describe("varied VR projection and player mappings", () => {
  test.each([
    ["film_180_fisheye_SBS.mp4", "fisheye", 180, "Linear", "sbs"],
    ["film_SBS_fisheye190.mp4", "fisheye190", 190, "Linear", "sbs"],
    ["film_SBS_mkx200.mp4", "mkx200", 200, "MKX200", "sbs"],
    ["film_SBS_mkx220.mp4", "mkx220", 220, "MKX220", "sbs"],
    ["film_SBS_vrca220.mp4", "vrca220", 220, "VRCA220", "sbs"],
    ["film_SBS_rf52.mp4", "rf52", 190, "Linear", "sbs"],
    ["film_360_TB.mp4", "sphere", 360, "Linear", "tb"],
    ["film_180.mp4", "dome", 180, "Linear", "off"],
    ["fishery-1800.mp4", "flat", 90, "Linear", "off"],
  ] as const)(
    "maps %s to the correct mesh and lens",
    (file_name, screenType, fov, lens, stereoMode) =>
      expect(projectionFor({ file_name })).toEqual({
        screenType,
        fov,
        lens,
        stereoMode,
      })
  );
  test("explicit metadata is normalized and defeats filename projection and stereo", () => {
    expect(
      projectionFor({ file_name: "film_180_fisheye_SBS.mp4" }, [
        { key: "vr.projection", value: " flat " },
        { key: "vr.stereo", value: " OFF " },
      ])
    ).toEqual({
      screenType: "flat",
      fov: 90,
      lens: "Linear",
      stereoMode: "off",
    });
    expect(
      projectionFor({ file_name: "film.mp4" }, [
        { key: "vr.projection", value: "fisheye" },
        { key: "vr.fov", value: "220" },
        { key: "vr.lens", value: "VRCA220" },
      ])
    ).toEqual({
      screenType: "fisheye",
      fov: 220,
      lens: "VRCA220",
      stereoMode: "off",
    });
  });
  test.each(["nonsense", "NaN", "Infinity", "0", "361"])(
    "ignores invalid field of view %s",
    (value) =>
      expect(
        projectionFor({ file_name: "film_fisheye190.mp4" }, [
          { key: "vr.fov", value },
        ]).fov
      ).toBe(190)
  );
  test("HereSphere 360 uses its projection selector with FOV 180 as XBVR; DeoVR keeps sphere", () => {
    const video = { ...base, file_name: "film_360_TB.mp4" };
    const here = hereVideo(video, "https://example/api/vr", "token");
    const deo = deoVideo(video, "https://example/api/vr", "token");
    expect(here.projection).toBe("equirectangular360");
    expect(here.fov).toBe(180);
    expect(here.stereo).toBe("tb");
    expect(deo.screenType).toBe("sphere");
    expect(deo.stereoMode).toBe("tb");
    expect(deo.encodings[0]!.name).toBe("h265");
  });
  test("HereSphere receives fisheye lens corrections and 8K source dimensions", () => {
    const here = hereVideo(
      { ...base, file_name: "film_SBS_mkx200.mp4" },
      "https://example/api/vr",
      "token"
    );
    expect(here.projection).toBe("fisheye");
    expect(here.fov).toBe(200);
    expect(here.lens).toBe("MKX200");
    expect(here.media[0]!.sources[0]!.width).toBe(7680);
    expect(here.duration).toBe(60500);
  });
});
