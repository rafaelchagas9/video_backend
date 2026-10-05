/**
 * Regenerate every storyboard that does not match the current standard (tile shape from the
 * video's aspect ratio, STORYBOARD_TILE_SHORT_SIDE, STORYBOARD_INTERVAL_SECONDS) and re-index
 * it for visual search right away.
 *
 *   bun scripts/regenerate-storyboards.ts                 # dry run: counts, order, estimate
 *   bun scripts/regenerate-storyboards.ts --apply [--limit N] [--video ID ...]
 *       [--concurrency N] [--rebuild-index] [--no-index]
 *
 * Outliers go first (sizes other than the old 320×240 / 240×320, wrong orientation, widened
 * intervals), then the rest, shortest first. Conforming storyboards are skipped, so the run is
 * safe to stop (Ctrl+C finishes active videos) and resume. Each storyboard stays served until
 * its replacement is published.
 *
 * --rebuild-index drops the HNSW index for the run and rebuilds it at the end, which is much
 * faster for a full backfill; visual searches are exact (slow) until it is back. Without it,
 * each video's vectors are replaced in the live index.
 */
import { sql } from "drizzle-orm";
import { env } from "@/config/env";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const apply = flag("--apply");
const limit = Number(value("--limit") ?? Infinity);
const concurrency = Math.max(1, Number(value("--concurrency") ?? env.STORYBOARD_MAX_CONCURRENT));
const onlyVideos = args
  .flatMap((arg, index) => (args[index - 1] === "--video" ? [Number(arg)] : []))
  .filter(Number.isFinite);

let stopping = false;
process.on("SIGINT", () => {
  if (stopping) process.exit(130);
  stopping = true;
  console.log("\nstopping after the active videos (Ctrl+C again to exit now)");
});

function hours(seconds: number): string {
  return seconds > 3600 ? `${(seconds / 3600).toFixed(1)} h` : `${Math.round(seconds / 60)} min`;
}

type Row = {
  video_id: number;
  width: number | null;
  height: number | null;
  duration_seconds: number;
  tile_width: number;
  tile_height: number;
  interval_seconds: number;
};

async function main() {
  const { db } = await import("@/config/drizzle");
  const { storyboardsService } = await import("@/modules/storyboards/storyboards.service");
  const { matchesStandard } = await import("@/modules/storyboards/storyboards.standard");

  const rows = await db.execute<Row>(sql`
    SELECT s.video_id, v.width, v.height, v.duration_seconds,
           s.tile_width, s.tile_height, s.interval_seconds
    FROM storyboards s JOIN videos v ON v.id = s.video_id
    WHERE v.is_available AND NOT v.is_deleted AND v.duration_seconds > 0`);

  const targets = rows
    .filter((row) => !onlyVideos.length || onlyVideos.includes(Number(row.video_id)))
    .map((row) => {
      const standard = storyboardsService.standardFor({
        width: row.width,
        height: row.height,
        durationSeconds: Number(row.duration_seconds),
      });
      const current = {
        tileWidth: Number(row.tile_width),
        tileHeight: Number(row.tile_height),
        intervalSeconds: Number(row.interval_seconds),
      };
      const oldSize =
        (current.tileWidth === 320 && current.tileHeight === 240) ||
        (current.tileWidth === 240 && current.tileHeight === 320);
      const wrongOrientation =
        row.width && row.height
          ? row.width > row.height !== current.tileWidth > current.tileHeight
          : false;
      const outlier =
        !oldSize || wrongOrientation || current.intervalSeconds !== env.STORYBOARD_INTERVAL_SECONDS;
      return {
        videoId: Number(row.video_id),
        duration: Number(row.duration_seconds),
        conforms: matchesStandard(current, standard),
        outlier,
      };
    })
    .filter((target) => !target.conforms)
    .sort((a, b) => Number(b.outlier) - Number(a.outlier) || a.duration - b.duration)
    .slice(0, limit);

  const outliers = targets.filter((target) => target.outlier).length;
  const videoSeconds = targets.reduce((sum, target) => sum + target.duration, 0);
  console.log(
    `${rows.length} storyboards, ${targets.length} to regenerate (${outliers} outliers first), ` +
      `${hours(videoSeconds)} of video`
  );
  // Benchmarked 2026-10-03: auto sampling runs ~45–800× realtime per worker depending on
  // whether keyframes cover the interval; precise decoding is the slow end.
  console.log(
    `estimate with ${concurrency} worker(s): ${hours(videoSeconds / 800 / concurrency)}–` +
      `${hours(videoSeconds / 45 / concurrency)} of generation`
  );
  if (!apply) {
    for (const target of targets.slice(0, 20))
      console.log(`  video ${target.videoId}${target.outlier ? " (outlier)" : ""}`);
    if (targets.length > 20) console.log(`  … ${targets.length - 20} more`);
    console.log("dry run; pass --apply to regenerate");
    return;
  }

  const index = !flag("--no-index");
  const { indexStoryboard } = await import("@/modules/visual-search/visual-search.indexer");
  const { visualSearchStore } = await import("@/modules/visual-search/visual-search.service");
  const { visualSearchClient } = await import("@/modules/visual-search/visual-search.client");
  if (index) {
    const status = await visualSearchClient.status();
    if (!status.ready) throw new Error(`Vision service clip capability is ${status.state}`);
  }
  if (index && flag("--rebuild-index")) {
    console.log("dropping HNSW index for the bulk load");
    await db.execute(sql`DROP INDEX IF EXISTS idx_video_frame_embeddings_hnsw`);
  }

  const store = visualSearchStore();
  const startedAt = Date.now();
  let cursor = 0;
  let done = 0;
  let processedSeconds = 0;
  const failures: { id: number; stage: string; message: string }[] = [];
  async function worker() {
    while (!stopping && cursor < targets.length) {
      const target = targets[cursor++]!;
      let stage = "generate";
      try {
        const storyboard = await storyboardsService.generate(target.videoId, undefined, {
          visualIndex: false,
        });
        if (index) {
          stage = "index";
          await indexStoryboard(store, storyboard);
        }
      } catch (error) {
        failures.push({
          id: target.videoId,
          stage,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      done++;
      processedSeconds += target.duration;
      const elapsed = (Date.now() - startedAt) / 1000;
      const eta = ((videoSeconds - processedSeconds) / processedSeconds) * elapsed;
      console.log(
        `[${done}/${targets.length}] video ${target.videoId} ` +
          `(${failures.length} failed, ETA ${hours(eta)})`
      );
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  if (index && flag("--rebuild-index")) {
    console.log("rebuilding HNSW index…");
    const built = Date.now();
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL maintenance_work_mem = '1GB'`);
      await tx.execute(sql`SET LOCAL max_parallel_maintenance_workers = 0`);
      await tx.execute(sql`
        CREATE INDEX IF NOT EXISTS idx_video_frame_embeddings_hnsw ON video_frame_embeddings
        USING hnsw (embedding halfvec_cosine_ops) WITH (m = 16, ef_construction = 64)`);
    });
    console.log(`index built in ${Math.round((Date.now() - built) / 1000)} s`);
  }
  console.log(`done: ${done - failures.length} regenerated in ${hours((Date.now() - startedAt) / 1000)}`);
  if (failures.length) {
    console.log(`${failures.length} failures (index failures: rerun scripts/index-visual-search.ts):`);
    for (const failure of failures.slice(0, 50))
      console.log(`  video ${failure.id} [${failure.stage}]: ${failure.message}`);
  }
}

try {
  await main();
  process.exit(0);
} catch (error) {
  console.error(error);
  process.exit(1);
}
