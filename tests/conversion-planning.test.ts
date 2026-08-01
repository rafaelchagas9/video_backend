import { describe, expect, it } from "bun:test";
import { CONVERSION_PRESETS } from "@/config/presets";
import {
  CONVERSION_PROFILE_VERSION,
  buildConversionBitratePlan,
  calculateEffectiveDimensions,
  calculateTargetResolution,
  parseBitrateToBps,
} from "@/modules/conversion/conversion.planning";

describe("conversion planning", () => {
  const preset = CONVERSION_PRESETS["1080p_av1"]!;

  it("does not plan a low-bitrate source above its original total bitrate", () => {
    const targetResolution = calculateTargetResolution(1920, 1080, preset);
    const plan = buildConversionBitratePlan(
      { width: 1920, height: 1080, bitrate: 5_000_000 },
      preset,
      targetResolution,
    );

    expect(targetResolution).toBe("original");
    expect(plan.profileVersion).toBe(CONVERSION_PROFILE_VERSION);
    expect(plan.videoBitrateBps).toBe(4_904_000);
    expect(plan.videoBitrateBps + plan.audioBitrateBps).toBe(5_000_000);
    expect(parseBitrateToBps(plan.bitrate)).toBe(4_904_000);
  });

  it("caps a high-bitrate 1080p source at 6 Mbps video", () => {
    const plan = buildConversionBitratePlan(
      { width: 1920, height: 1080, bitrate: 18_000_000 },
      preset,
      "original",
    );

    expect(plan.videoBitrateBps).toBe(6_000_000);
    expect(plan.maxBitrateBps).toBe(6_000_000);
  });

  it("uses the lower resolution cap for a 720p source", () => {
    const plan = buildConversionBitratePlan(
      { width: 1280, height: 720, bitrate: 8_000_000 },
      preset,
      "original",
    );

    expect(plan.videoBitrateBps).toBe(4_000_000);
    expect(plan.maxBitrateBps).toBe(4_000_000);
  });

  it("calculates the effective dimensions of downscaled landscape and portrait video", () => {
    expect(calculateTargetResolution(3840, 2160, preset)).toBe("1920x-2");
    expect(calculateEffectiveDimensions(3840, 2160, "1920x-2")).toEqual({
      width: 1920,
      height: 1080,
    });

    expect(calculateTargetResolution(2160, 3840, preset)).toBe("-2x1920");
    expect(calculateEffectiveDimensions(2160, 3840, "-2x1920")).toEqual({
      width: 1080,
      height: 1920,
    });
  });

  it("describes AV1 resolution presets as upper bounds", () => {
    expect(CONVERSION_PRESETS["1080p_av1"]?.name).toBe("AV1 up to 1080p");
    expect(CONVERSION_PRESETS["720p_av1"]?.name).toBe("AV1 up to 720p");
  });
});
