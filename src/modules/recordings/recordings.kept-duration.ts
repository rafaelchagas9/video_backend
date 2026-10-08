/** Total kept timeline coverage, counting overlapping choices once and ignoring invalid ranges. */
export function keptRecordingSeconds(
  clips: { keep: boolean; start_seconds: number; end_seconds: number }[],
  durationSeconds: number | null,
): number {
  const limit = durationSeconds !== null && Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : Infinity;
  const ranges = clips.filter((clip) => clip.keep && Number.isFinite(clip.start_seconds) && Number.isFinite(clip.end_seconds))
    .map((clip) => ({ start: Math.max(0, clip.start_seconds), end: Math.min(limit, clip.end_seconds) }))
    .filter((range) => range.end > range.start).sort((a, b) => a.start - b.start);
  let seconds = 0;
  let end = 0;
  for (const range of ranges) {
    seconds += Math.max(0, range.end - Math.max(end, range.start));
    end = Math.max(end, range.end);
  }
  return seconds;
}
