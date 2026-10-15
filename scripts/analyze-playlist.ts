/**
 * Finds highlights in every video of a playlist, so downloaded recordings join the review queue
 * (as "from library") to have their highlights marked. Same steps as the recordings processing
 * queue: storyboard and visual index when missing, hover preview, then the analysis. Videos that
 * already have a review are left alone.
 *
 * Dry run by default; `--apply` analyses. One video at a time, in playlist order.
 *
 *   bun scripts/analyze-playlist.ts Trim
 *   bun scripts/analyze-playlist.ts Trim --apply
 */

import { sql } from "drizzle-orm";
import { db } from "@/config/drizzle";

const name = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
const apply = process.argv.includes("--apply");
if (!name) {
  console.error("Usage: bun scripts/analyze-playlist.ts <playlist name> [--apply]");
  process.exit(1);
}

const rows = await db.execute<{ id: number; file_name: string; file_path: string; duration_seconds: number | null; reviewed: boolean }>(sql`
  SELECT v.id, v.file_name, v.file_path, v.duration_seconds,
    EXISTS (SELECT 1 FROM recording_reviews r WHERE r.video_id = v.id) AS reviewed
  FROM playlists p JOIN playlist_videos pv ON pv.playlist_id = p.id JOIN videos v ON v.id = pv.video_id
  WHERE lower(p.name) = lower(${name})
  ORDER BY pv.position ASC, v.id ASC`);
const todo = rows.filter((row) => !row.reviewed && row.duration_seconds);
const hours = todo.reduce((sum, row) => sum + Number(row.duration_seconds), 0) / 3600;
console.log(`${name}: ${rows.length} videos, ${rows.length - todo.length} already analysed or without a length, ${todo.length} to analyse (${hours.toFixed(1)} h)`);
if (!apply) {
  for (const row of todo) console.log(`  ${row.id}  ${row.file_name}`);
  console.log("Dry run. Pass --apply to analyse.");
  process.exit(0);
}

const [{ getFaceRecognitionService }, { previewsService }, { recordingsService }] = await Promise.all([
  import("@/modules/face-recognition/face-recognition.service"),
  import("@/modules/previews/previews.service"),
  import("@/modules/recordings/recordings.service"),
]);
let done = 0;
for (const row of todo) {
  const started = Date.now();
  try {
    const [storyboard] = await db.execute<{ has: boolean }>(sql`SELECT EXISTS (SELECT 1 FROM storyboards WHERE video_id = ${row.id}) AS has`);
    // visualIndex: false; analyze() indexes the video itself.
    if (!storyboard?.has)
      await getFaceRecognitionService().processVideo(row.id, row.file_path, Number(row.duration_seconds), { faces: false, visualIndex: false });
    await previewsService.queueGenerate(row.id);
    const review = await recordingsService.analyze(1, row.id, { automatic: true });
    done += 1;
    console.log(`[${done}/${todo.length}] ${row.id} ${row.file_name}: ${review?.clips.length ?? 0} proposals in ${Math.round((Date.now() - started) / 1000)} s`);
  } catch (error) {
    console.log(`[failed] ${row.id} ${row.file_name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
process.exit(0);
