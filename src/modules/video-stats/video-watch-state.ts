const COMPLETION_THRESHOLD = 0.95;

export interface VideoWatchStateInput {
  playCount: number | null | undefined;
  positionSeconds: number | null | undefined;
  durationSeconds: number | null | undefined;
}

/**
 * A counted play is not necessarily a finished video: play_count increments
 * after the configured minimum watch time. Completion therefore follows the
 * UI's 95% convention. Players may reset position to zero after completion,
 * so a counted play at zero is also considered finished.
 */
export function isVideoWatched({
  playCount,
  positionSeconds,
  durationSeconds,
}: VideoWatchStateInput): boolean {
  if (!playCount || playCount <= 0) return false;
  if (positionSeconds === 0) return true;
  if (
    positionSeconds == null ||
    positionSeconds < 0 ||
    durationSeconds == null ||
    durationSeconds <= 0
  ) {
    return false;
  }
  return positionSeconds / durationSeconds >= COMPLETION_THRESHOLD;
}
