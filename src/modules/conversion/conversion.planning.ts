import type { ConversionPreset } from "@/config/presets";

export const CONVERSION_PROFILE_VERSION = 2;
const MIN_VIDEO_BITRATE_BPS = 100_000;

export interface ConversionPlanningSource {
  width: number | null;
  height: number | null;
  bitrate: number | null;
}

export interface ConversionBitratePlan {
  profileVersion: number;
  bitrate: string;
  maxrate: string;
  bufsize: string;
  videoBitrateBps: number;
  maxBitrateBps: number;
  bufferSizeBps: number;
  audioBitrateBps: number;
  qp: number;
}

export interface EffectiveDimensions {
  width: number;
  height: number;
}

export function parseBitrateToBps(value: string): number {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*([kKmMgG])?$/);
  if (!match) {
    throw new Error(`Invalid bitrate: ${value}`);
  }

  const amount = Number(match[1]);
  const unit = match[2]?.toLowerCase();
  const multiplier =
    unit === "g"
      ? 1_000_000_000
      : unit === "m"
        ? 1_000_000
        : unit === "k"
          ? 1_000
          : 1;

  return Math.round(amount * multiplier);
}

export function formatBitrate(bps: number): string {
  return `${Math.max(1, Math.round(bps / 1_000))}k`;
}

export function getMaxRate(
  width: number,
  codec: "av1" | "hevc" | "h264",
): string {
  const rates: Record<string, Record<number, string>> = {
    av1: {
      3840: "25M",
      2560: "15M",
      1920: "6M",
      1280: "4M",
      854: "3M",
    },
    hevc: {
      3840: "35M",
      2560: "20M",
      1920: "15M",
      1280: "8M",
      854: "4M",
    },
    h264: {
      3840: "50M",
      2560: "30M",
      1920: "20M",
      1280: "10M",
      854: "5M",
    },
  };

  const codecRates = rates[codec];
  const widths = Object.keys(codecRates)
    .map(Number)
    .sort((a, b) => b - a);

  for (const candidateWidth of widths) {
    if (width >= candidateWidth) {
      return codecRates[candidateWidth]!;
    }
  }

  return codecRates[widths[widths.length - 1]!]!;
}

export function calculateTargetResolution(
  width: number | null,
  height: number | null,
  preset: ConversionPreset,
): string {
  if (preset.targetWidth === null) {
    return "original";
  }

  if (!width || !height) {
    return `${preset.targetWidth}x-2`;
  }

  if (height < 720) {
    return "original";
  }

  const isPortrait = height > width;
  const target = preset.targetWidth;

  if (isPortrait) {
    return height <= target ? "original" : `-2x${target}`;
  }

  return width <= target ? "original" : `${target}x-2`;
}

export function calculateEffectiveDimensions(
  width: number | null,
  height: number | null,
  targetResolution: string | null,
): EffectiveDimensions | null {
  if (!width || !height) {
    return null;
  }

  if (!targetResolution || targetResolution === "original") {
    return { width, height };
  }

  const [targetWidthText, targetHeightText] = targetResolution.split("x");
  const targetWidth =
    targetWidthText && targetWidthText !== "-2"
      ? Number.parseInt(targetWidthText, 10)
      : null;
  const targetHeight =
    targetHeightText && targetHeightText !== "-2"
      ? Number.parseInt(targetHeightText, 10)
      : null;

  const scale = Math.min(
    targetWidth ? targetWidth / width : Number.POSITIVE_INFINITY,
    targetHeight ? targetHeight / height : Number.POSITIVE_INFINITY,
    1,
  );

  if (!Number.isFinite(scale) || scale <= 0) {
    return { width, height };
  }

  return {
    width: Math.max(2, Math.round((width * scale) / 2) * 2),
    height: Math.max(2, Math.round((height * scale) / 2) * 2),
  };
}

export function buildConversionBitratePlan(
  source: ConversionPlanningSource,
  preset: ConversionPreset,
  targetResolution: string | null,
): ConversionBitratePlan {
  const codec = preset.codec.replace("_vaapi", "") as "av1" | "hevc" | "h264";
  const dimensions = calculateEffectiveDimensions(
    source.width,
    source.height,
    targetResolution,
  );
  const effectiveWidth =
    dimensions?.width ?? source.width ?? preset.targetWidth ?? 1920;
  const resolutionCapBps = parseBitrateToBps(getMaxRate(effectiveWidth, codec));
  const presetCapBps = preset.maxBitrate
    ? parseBitrateToBps(preset.maxBitrate)
    : resolutionCapBps;
  const capBps = Math.min(resolutionCapBps, presetCapBps);
  const audioBitrateBps = parseBitrateToBps(preset.audioBitrate);

  // Source bitrate is the container total. Reserve room for the planned Opus
  // audio stream so a low-bitrate input is never deliberately targeted above
  // its original total bitrate.
  const sourceVideoBudgetBps =
    source.bitrate && source.bitrate > 0
      ? Math.max(MIN_VIDEO_BITRATE_BPS, source.bitrate - audioBitrateBps)
      : capBps;
  const videoBitrateBps = Math.min(capBps, sourceVideoBudgetBps);
  const maxBitrateBps = Math.min(
    capBps,
    Math.max(videoBitrateBps, Math.round(videoBitrateBps * 1.2)),
  );
  const bufferSizeBps = maxBitrateBps * 2;

  return {
    profileVersion: CONVERSION_PROFILE_VERSION,
    bitrate: formatBitrate(videoBitrateBps),
    maxrate: formatBitrate(maxBitrateBps),
    bufsize: formatBitrate(bufferSizeBps),
    videoBitrateBps,
    maxBitrateBps,
    bufferSizeBps,
    audioBitrateBps,
    qp: preset.qp,
  };
}

export function formatEffectiveResolution(
  dimensions: EffectiveDimensions | null,
  targetResolution: string | null,
): string | null {
  if (dimensions) {
    return `${dimensions.width}x${dimensions.height}`;
  }

  return targetResolution ?? null;
}
