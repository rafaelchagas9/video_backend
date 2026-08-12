import { describe, expect, it } from "bun:test";
import {
  classifyFfmpegFailure,
  FfmpegProcessError,
} from "@/modules/conversion/conversion.ffmpeg.service";

describe("FFmpeg failure normalization", () => {
  it("uses a stable error type and preserves its original cause", () => {
    const cause = new Error("spawn ENOENT");
    const error = new FfmpegProcessError(
      "FFmpeg conversion process failed to start",
      "hw",
      null,
      "",
      { cause }
    );

    expect(error.name).toBe("FfmpegProcessError");
    expect(error.message).not.toContain("ENOENT");
    expect(error.cause).toBe(cause);
  });

  it("classifies volatile stderr into narrow grouping categories", () => {
    expect(classifyFfmpegFailure("No space left on device")).toBe("disk_full");
    expect(
      classifyFfmpegFailure("Rate limit exceeded, retry in 1 minute")
    ).toBe("rate_limit");
    expect(classifyFfmpegFailure("Failed setup for format vaapi")).toBe(
      "hardware_acceleration"
    );
    expect(classifyFfmpegFailure("unrecognized diagnostic output")).toBe(
      "unknown"
    );
  });
});
