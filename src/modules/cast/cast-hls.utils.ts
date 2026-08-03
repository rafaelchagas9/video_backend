import { extname } from "path";

export interface ByteRange {
  start: number;
  end: number;
}

export interface HlsBandwidth {
  average: number;
  peak: number;
}

export function parseByteRange(
  rangeHeader: string,
  fileSize: number
): ByteRange | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match || fileSize <= 0) return null;

  const startText = match[1] ?? "";
  const endText = match[2] ?? "";
  if (startText === "" && endText === "") return null;

  let start: number;
  let end: number;
  if (startText === "") {
    const suffixLength = Number(endText);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
    start = Math.max(0, fileSize - suffixLength);
    end = fileSize - 1;
  } else {
    start = Number(startText);
    end = endText === "" ? fileSize - 1 : Number(endText);
  }

  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start >= fileSize ||
    end < start
  ) {
    return null;
  }

  return { start, end: Math.min(end, fileSize - 1) };
}

export function calculateHlsBandwidth(
  playlist: string,
  sizesByAsset: ReadonlyMap<string, number>
): HlsBandwidth | null {
  const lines = playlist.split(/\r?\n/);
  let pendingDuration: number | null = null;
  let totalBits = 0;
  let totalDuration = 0;
  let peak = 0;

  for (const line of lines) {
    if (line.startsWith("#EXTINF:")) {
      const duration = Number(line.slice("#EXTINF:".length).split(",", 1)[0]);
      pendingDuration =
        Number.isFinite(duration) && duration > 0 ? duration : null;
      continue;
    }

    if (!pendingDuration || line === "" || line.startsWith("#")) continue;
    const size = sizesByAsset.get(line);
    if (size !== undefined && size >= 0) {
      const bits = size * 8;
      totalBits += bits;
      totalDuration += pendingDuration;
      peak = Math.max(peak, bits / pendingDuration);
    }
    pendingDuration = null;
  }

  if (totalDuration <= 0 || peak <= 0) return null;
  return {
    average: Math.ceil(totalBits / totalDuration),
    // Leave headroom for measurement rounding and receiver bandwidth selection.
    peak: Math.ceil(peak * 1.05),
  };
}

export function getCastAssetKind(
  asset: string
): "manifest" | "initialization" | "segment" | "unknown" {
  if (asset.endsWith(".m3u8")) return "manifest";
  if (asset === "init.mp4") return "initialization";
  if ([".ts", ".m4s"].includes(extname(asset))) return "segment";
  return "unknown";
}
