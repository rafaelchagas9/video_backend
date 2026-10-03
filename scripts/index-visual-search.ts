/**
 * Build the SigLIP2 visual-search index from existing storyboards.
 *
 *   bun scripts/index-visual-search.ts [--limit N] [--rebuild-index] [--video ID ...]
 *   DEMO_MODE=true bun scripts/index-visual-search.ts --demo
 *
 * Library mode indexes every video whose index is missing or stale (newest first) and is
 * safe to stop and resume. With --rebuild-index the HNSW index is dropped first and rebuilt
 * at the end, which is much faster than maintaining it during a full backfill; searches are
 * exact (slow) until it is back.
 *
 * Demo mode embeds each demo source file once and writes demo_mode/visual/*, which demo
 * searches read (the demo database itself is reset from its baseline on every start).
 */
import { sql } from "drizzle-orm";
import { env } from "@/config/env";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const limit = Number(value("--limit") ?? Infinity);
const onlyVideos = args
  .flatMap((arg, index) => (args[index - 1] === "--video" ? [Number(arg)] : []))
  .filter(Number.isFinite);

function eta(done: number, total: number, startedAt: number): string {
  if (!done) return "?";
  const seconds = ((Date.now() - startedAt) / done) * (total - done) / 1000;
  return seconds > 3600
    ? `${(seconds / 3600).toFixed(1)} h`
    : `${Math.round(seconds / 60)} min`;
}

async function demo() {
  if (!env.DEMO_MODE) throw new Error("Run demo indexing with DEMO_MODE=true");
  const { basename } = await import("node:path");
  const { demoRepository } = await import("@/database/demo/repository");
  const { storyboardsService } = await import("@/modules/storyboards/storyboards.service");
  const { indexStoryboard } = await import("@/modules/visual-search/visual-search.indexer");
  const { DemoVisualSearchStore } = await import(
    "@/modules/visual-search/visual-search.demo.store"
  );
  const page = demoRepository.getVideos({ limit: 10_000, page: 1 }) as {
    data: { id: number; file_path: string }[];
  };
  const byFile = new Map<string, number>();
  for (const video of page.data)
    if (!byFile.has(basename(video.file_path))) byFile.set(basename(video.file_path), video.id);
  // An empty resolver: the generator starts from scratch rather than the existing files.
  const store = new DemoVisualSearchStore(async () => new Map());
  const fileNames = new Map<number, string>();
  let done = 0;
  for (const [fileName, videoId] of byFile) {
    const storyboard = await storyboardsService.findByVideoId(videoId);
    if (!storyboard) {
      console.warn(`skip ${fileName}: no storyboard`);
      continue;
    }
    const meta = await indexStoryboard(store, storyboard);
    fileNames.set(videoId, fileName);
    console.log(`[${++done}/${byFile.size}] ${fileName}: ${meta.frameCount} frames`);
  }
  store.persist(fileNames);
  console.log(`wrote ${done} demo videos`);
}

async function library() {
  const { db } = await import("@/config/drizzle");
  const { storyboardsService } = await import("@/modules/storyboards/storyboards.service");
  const { indexStoryboard } = await import("@/modules/visual-search/visual-search.indexer");
  const { visualSearchStore } = await import("@/modules/visual-search/visual-search.service");
  const { currentVisualIndexIds } = await import("@/modules/visual-search/visual-search.jobs");
  const { visualSearchClient } = await import("@/modules/visual-search/visual-search.client");

  const status = await visualSearchClient.status();
  if (!status.ready) throw new Error(`Vision service clip capability is ${status.state}`);

  const rows = await db.execute<{ video_id: number }>(sql`
    SELECT s.video_id FROM storyboards s
    JOIN videos v ON v.id = s.video_id
    WHERE v.is_available AND NOT v.is_deleted
    ORDER BY v.created_at DESC, v.id DESC`);
  let ids = rows.map((row) => Number(row.video_id));
  if (onlyVideos.length) ids = ids.filter((id) => onlyVideos.includes(id));
  const current = await currentVisualIndexIds(ids);
  const todo = ids.filter((id) => !current.has(id)).slice(0, limit);
  console.log(`${ids.length} videos with storyboards, ${current.size} current, ${todo.length} to index`);

  if (flag("--rebuild-index")) {
    console.log("dropping HNSW index for the bulk load");
    await db.execute(sql`DROP INDEX IF EXISTS idx_video_frame_embeddings_hnsw`);
  }

  const store = visualSearchStore();
  const startedAt = Date.now();
  let done = 0;
  let frames = 0;
  const failures: { id: number; message: string }[] = [];
  // Two videos in flight: one reads/inserts while the other is on the GPU.
  let cursor = 0;
  async function worker() {
    while (cursor < todo.length) {
      const id = todo[cursor++]!;
      try {
        const storyboard = await storyboardsService.findByVideoId(id);
        if (!storyboard) throw new Error("no storyboard");
        const meta = await indexStoryboard(store, storyboard);
        frames += meta.frameCount;
      } catch (error) {
        failures.push({ id, message: error instanceof Error ? error.message : String(error) });
      }
      done++;
      if (done % 10 === 0 || done === todo.length) {
        const rate = frames / ((Date.now() - startedAt) / 1000);
        console.log(
          `[${done}/${todo.length}] ${frames} frames, ${rate.toFixed(0)} frames/s, ${failures.length} failed, ETA ${eta(done, todo.length, startedAt)}`
        );
      }
    }
  }
  await Promise.all([worker(), worker()]);

  if (flag("--rebuild-index")) {
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
  if (failures.length) {
    console.log(`${failures.length} failures:`);
    for (const failure of failures.slice(0, 50)) console.log(`  video ${failure.id}: ${failure.message}`);
  }
}

try {
  if (flag("--demo")) await demo();
  else await library();
  process.exit(0);
} catch (error) {
  console.error(error);
  process.exit(1);
}
