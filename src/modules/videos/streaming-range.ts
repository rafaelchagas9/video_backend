export interface ParsedRange {
  start: number;
  end: number;
}

/** Single byte ranges only. Explicit/open ranges retain the configured chunk cap. */
export function parseRangeHeader(
  rangeHeader: string,
  fileSize: number,
  maxChunkBytes: number,
): ParsedRange | null {
  if (!Number.isSafeInteger(fileSize) || fileSize <= 0 ||
      !Number.isSafeInteger(maxChunkBytes) || maxChunkBytes <= 0) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
  if (!match || (!match[1] && !match[2])) return null;
  const first = match[1] ? Number(match[1]) : null;
  const last = match[2] ? Number(match[2]) : null;
  if ((first !== null && !Number.isSafeInteger(first)) ||
      (last !== null && !Number.isSafeInteger(last))) return null;
  if (first === null) {
    if (last === null || last <= 0) return null;
    // Keep suffix ranges intact: clients may request a complete trailing index.
    return { start: Math.max(0, fileSize - last), end: fileSize - 1 };
  }
  if (first >= fileSize || (last !== null && first > last)) return null;
  return {
    start: first,
    end: Math.min(last ?? fileSize - 1, fileSize - 1,
      first + Math.min(maxChunkBytes, fileSize - first) - 1),
  };
}
