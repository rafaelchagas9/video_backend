import { inArray } from "drizzle-orm";
import { db } from "@/config/drizzle";
import { env } from "@/config/env";
import { storyboardsTable } from "@/database/schema";
import { mediaWorkScheduler } from "@/utils/media-work-scheduler";
import { storyboardsService } from "@/modules/storyboards/storyboards.service";
import { logger } from "@/utils/logger";
import { visualSearchClient } from "./visual-search.client";
import { indexStoryboard, VisualIndexError } from "./visual-search.indexer";
import { visualSearchStore } from "./visual-search.service";

/**
 * Videos whose index is current: built from the storyboard that exists now, by the model the
 * vision service runs now. A regenerated storyboard or a model swap makes a video pending again.
 */
export async function currentVisualIndexIds(videoIds: number[]): Promise<Set<number>> {
  if (!videoIds.length) return new Set();
  const store = visualSearchStore();
  const [indexed, status] = await Promise.all([
    store.indexed(videoIds),
    visualSearchClient.status(),
  ]);
  if (env.DEMO_MODE) return new Set(indexed.keys());
  const storyboards = await db
    .select({ videoId: storyboardsTable.videoId, generatedAt: storyboardsTable.generatedAt })
    .from(storyboardsTable)
    .where(inArray(storyboardsTable.videoId, [...indexed.keys()]));
  const current = new Set<number>();
  for (const storyboard of storyboards) {
    const row = indexed.get(storyboard.videoId);
    if (!row) continue;
    if (row.storyboardGeneratedAt.getTime() !== storyboard.generatedAt.getTime()) continue;
    if (status.modelRevision && row.modelRevision !== status.modelRevision) continue;
    current.add(storyboard.videoId);
  }
  return current;
}

/** Index one video, generating its storyboard first when it has none. */
export async function indexVideoVisually(
  videoId: number,
  signal: AbortSignal
): Promise<{ frames: number }> {
  let storyboard = await storyboardsService.findByVideoId(videoId);
  if (!storyboard) {
    await mediaWorkScheduler.run("background", () => storyboardsService.generate(videoId), signal);
    storyboard = await storyboardsService.findByVideoId(videoId);
  }
  if (!storyboard) throw new VisualIndexError("Video has no storyboard", "NO_STORYBOARD");
  const meta = await indexStoryboard(visualSearchStore(), storyboard, signal);
  return { frames: meta.frameCount };
}

const pending = new Set<number>();
let draining = false;

/**
 * Index freshly generated storyboards in the background, one at a time. When the model is not
 * loaded the video simply stays pending; the library-sync "visual" task catches it up later.
 */
export function queueVisualIndex(videoId: number): void {
  if (env.DEMO_MODE) return;
  pending.add(videoId);
  if (draining) return;
  draining = true;
  void (async () => {
    try {
      while (pending.size) {
        const next = pending.values().next().value!;
        pending.delete(next);
        const status = await visualSearchClient.status();
        if (!status.ready) {
          pending.clear();
          return;
        }
        try {
          const storyboard = await storyboardsService.findByVideoId(next);
          if (storyboard) {
            await indexStoryboard(visualSearchStore(), storyboard);
            // A finished live recording gets its highlights proposed right away.
            void import("@/modules/recordings/recordings.service")
              .then(({ recordingsService }) => recordingsService.autoAnalyze(next))
              .catch(() => {});
          }
        } catch (error) {
          logger.warn({ error, videoId: next }, "Visual indexing of a new storyboard failed");
        }
      }
    } finally {
      draining = false;
    }
  })();
}
