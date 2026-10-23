/**
 * Downloads every accepted scene cover (`cover_image_url` metadata) that is not
 * stored yet, so thumbnails and artwork can use it. New accepts do this on
 * their own; this covers scenes enriched before covers were kept on disk.
 *
 *   bun scripts/backfill-source-covers.ts              # download only
 *   bun scripts/backfill-source-covers.ts --artwork    # also re-cut artwork from the covers
 */

import { eq } from "drizzle-orm";
import { db } from "../src/config/drizzle";
import { videoArtworkTable, videoMetadataTable, videoSourceCoversTable, videosTable } from "../src/database/schema";
import { sourceCoversService } from "../src/modules/source-covers/source-covers.service";

const withArtwork = process.argv.includes("--artwork");

const rows = await db
  .select({ videoId: videoMetadataTable.videoId, url: videoMetadataTable.value, stored: videoSourceCoversTable.sourceUrl })
  .from(videoMetadataTable)
  // Metadata can outlive its video; those covers have nothing to belong to.
  .innerJoin(videosTable, eq(videosTable.id, videoMetadataTable.videoId))
  .leftJoin(videoSourceCoversTable, eq(videoSourceCoversTable.videoId, videoMetadataTable.videoId))
  .where(eq(videoMetadataTable.key, "cover_image_url"));

const pending = rows.filter((row) => row.stored !== row.url.trim());
console.log(`${rows.length} covers on file, ${pending.length} to download`);

let done = 0;
const failed: number[] = [];
for (const row of pending) {
  try {
    await sourceCoversService.sync(row.videoId, { regenerate: false });
    done += 1;
  } catch (error) {
    failed.push(row.videoId);
    console.warn(`video ${row.videoId}: ${error instanceof Error ? error.message : error}`);
  }
}
console.log(`downloaded ${done}, failed ${failed.length}${failed.length ? ` (${failed.join(", ")})` : ""}`);

if (withArtwork) {
  const { artworkService } = await import("../src/modules/artwork/artwork.service");
  const { RASTER_ARTWORK_VARIANTS } = await import("../src/modules/artwork/artwork.types");
  const stored = await db.select({ videoId: videoSourceCoversTable.videoId }).from(videoSourceCoversTable);
  const ids = stored.map((row) => row.videoId);
  await artworkService.requestBatch({ video_ids: ids, variants: [...RASTER_ARTWORK_VARIANTS], force: true });
  // The queue drains in this process; wait for it before exiting.
  for (;;) {
    const busy = await db
      .select({ videoId: videoArtworkTable.videoId })
      .from(videoArtworkTable)
      .where(eq(videoArtworkTable.status, "generating"));
    const left = busy.filter((row) => ids.includes(row.videoId)).length;
    if (left === 0) break;
    console.log(`artwork: ${left} left`);
    await Bun.sleep(5000);
  }
  console.log(`artwork re-cut for ${ids.length} videos`);
}
process.exit(failed.length > 0 ? 1 : 0);
