import { expect, it, mock } from "bun:test";
import { CONVERSION_PRESETS } from "@/config/presets";

mock.module("@/config/env", () => ({
  env: { NODE_ENV: "test", VAAPI_DEVICE: "/dev/dri/renderD128" },
}));
const { FfmpegService } =
  await import("@/modules/conversion/conversion.ffmpeg.service");

it("keeps uploaded frames on the GPU when the software decoder fallback resizes", () => {
  const service = new FfmpegService() as any;
  for (const encodingMode of ["hw", "sw_decode", "full_sw"]) {
    for (const targetResolution of [
      "1920x1080",
      "1920x-2",
      "-2x1080",
      "original",
    ]) {
      const args = service.buildArgs({
        inputPath: "/synthetic/input.mkv",
        outputPath: "/synthetic/output.mkv",
        preset: CONVERSION_PRESETS["1080p_av1"],
        targetResolution,
        bitrate: "2M",
        maxrate: "3M",
        bufsize: "6M",
        encodingMode,
      }) as string[];
      const filter = args.includes("-vf") ? args[args.indexOf("-vf") + 1]! : "";
      if (encodingMode === "sw_decode")
        expect(filter).toStartWith("format=nv12,hwupload");
      if (targetResolution !== "original") {
        expect(filter).toContain(
          encodingMode === "full_sw" ? "scale=" : "scale_vaapi="
        );
      } else expect(filter).not.toContain("scale");
      expect(filter).not.toContain("hwupload,scale=");
    }
  }
});

it("keeps the conversion cancellation contract while waiting for shared GPU capacity", async () => {
  const { mediaWorkScheduler } = await import("@/utils/media-work-scheduler");
  const { ConversionCancelledError } =
    await import("@/modules/conversion/conversion.ffmpeg.service");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const busy = [0, 1].map(() =>
    mediaWorkScheduler.run("background", () => gate)
  );
  const signal = new AbortController();
  const pending = new FfmpegService().runConversion(
    1,
    {} as Parameters<InstanceType<typeof FfmpegService>["runConversion"]>[1],
    "/synthetic/source.mkv",
    "/synthetic/output.mkv",
    CONVERSION_PRESETS["1080p_av1"]!,
    "1920x1080",
    undefined,
    signal.signal
  );
  signal.abort();
  try {
    await expect(pending).rejects.toBeInstanceOf(ConversionCancelledError);
  } finally {
    release();
    await Promise.all(busy);
  }
});
