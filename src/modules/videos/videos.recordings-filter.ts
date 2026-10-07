import { recordingScope } from "@/modules/recordings/recordings.scope";
import type { ListVideosOptions } from "./videos.types";

/** Turns `hideRecordings` into the videos to leave out; asking for the recordings folder by name shows it. */
export async function withRecordingsHidden(options: ListVideosOptions): Promise<ListVideosOptions> {
  if (!options.hideRecordings) return options;
  const scope = await recordingScope();
  if (!scope.directoryId || (options.directory_id === scope.directoryId && scope.minDurationSeconds === null)) return options;
  return { ...options, excludeRecordings: { directoryId: scope.directoryId, minDurationSeconds: scope.minDurationSeconds } };
}
