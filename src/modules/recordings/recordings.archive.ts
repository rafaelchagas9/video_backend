/**
 * Moving reviewed recordings to the NAS instead of keeping them on the local disk.
 *
 * A recording moves only once its review is finished (kept highlights rendered, or saved with
 * nothing kept). Each move makes a checksum-verified copy under RECORDING_ARCHIVE_DIR together
 * with everything needed to use it again without Kura's catalog: its catalog row, review, label
 * answers, clip decisions and training snapshot. Only then is it deleted the way any library
 * delete is (catalog rows, thumbnails, storyboards, previews and the file, through GoondVR when
 * GoondVR owns it). The NAS must be mounted: an archive folder on the recording's own disk is
 * refused, so an unmounted share can never fill the local disk instead.
 *
 * Layout: <root>/originals/<video id>/{<file name>, catalog.json, training-snapshot/},
 * <root>/receipts.jsonl (one "copied" and one "removed" line per move), <root>/README.md.
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { appendFile, cp, mkdir, rename, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { eq, sql } from "drizzle-orm";
import { db } from "@/config/drizzle";
import { env } from "@/config/env";
import { recordingReviewsTable } from "@/database/schema";
import { videosService } from "@/modules/videos/videos.service";
import { videosBulkService } from "@/modules/videos/videos.bulk.service";
import { AppError, BadRequestError } from "@/utils/errors";
import { logger } from "@/utils/logger";
import { preserveRecordingReviewsBeforeDeletion } from "./recordings.deletion-preflight";
import { goondvr } from "./recordings.goondvr";
import { recordingScope } from "./recordings.scope";

const root = () => resolve(env.RECORDING_ARCHIVE_DIR);
const snapshots = () => resolve(process.cwd(), "data/recording-training-snapshots");

/**
 * Finished reviews whose original is still here: saved, not rendering, every keep made into a clip.
 * Only GoondVR's recordings folder: a library video reviewed for highlights is the user's to keep.
 */
async function archivable() {
  const { directoryId } = await recordingScope();
  return sql`
    (r.status = 'done' OR r.saved_at IS NOT NULL) AND r.status <> 'rendering'
    AND v.directory_id = ${directoryId ?? -1}
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(r.clips) c
      WHERE (c->>'keep')::boolean AND c->>'output_video_id' IS NULL)`;
}

export interface ArchiveStatus {
  /** The archive folder exists on another disk than the recordings. */
  nas_available: boolean;
  root: string;
  eligible: { count: number; bytes: number };
  running: boolean;
  queued: number;
  moved: { count: number; bytes: number };
  failed: { video_id: number; error: string }[];
}

const state = { running: false, queue: [] as number[], moved: 0, movedBytes: 0, failed: [] as { video_id: number; error: string }[] };

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), new Transform({ transform(chunk, _encoding, done) { hash.update(chunk); done(); } }));
  return hash.digest("hex");
}

/** The archive folder must exist (it is not created, so an unmounted share fails) and sit on another disk. */
async function assertNas(sourcePath: string): Promise<void> {
  const folder = await stat(root()).catch(() => null);
  if (!folder?.isDirectory()) throw new AppError(503, `The NAS archive folder ${root()} is not available. Is the NAS mounted?`);
  const source = await stat(sourcePath);
  if (folder.dev === source.dev) throw new AppError(503, `${root()} is on the same disk as the recordings; the NAS is probably not mounted`);
}

async function nasAvailable(): Promise<boolean> {
  const folder = await stat(root()).catch(() => null);
  const local = await stat(process.cwd()).catch(() => null);
  return Boolean(folder?.isDirectory() && local && folder.dev !== local.dev);
}

async function journal(entry: Record<string, unknown>): Promise<void> {
  await appendFile(resolve(root(), "receipts.jsonl"), `${JSON.stringify({ ...entry, at: new Date().toISOString() })}\n`);
}

/** Copies through a .partial file while hashing, then re-reads the NAS copy to prove it. Reuses a proven earlier copy. */
async function verifiedCopy(source: string, destination: string): Promise<string> {
  const expected = await sha256(source);
  if (await stat(destination).then(() => true).catch(() => false)) {
    if ((await sha256(destination)) === expected) return expected;
  }
  const partial = `${destination}.partial`;
  const hash = createHash("sha256");
  await pipeline(
    createReadStream(source),
    new Transform({ transform(chunk, _encoding, done) { hash.update(chunk); done(null, chunk); } }),
    createWriteStream(partial, { mode: 0o600 })
  );
  if (hash.digest("hex") !== expected) throw new Error("The recording changed while it was being copied");
  await rename(partial, destination);
  if ((await sha256(destination)) !== expected) throw new Error("The NAS copy does not match the original");
  return expected;
}

async function writeReadme(): Promise<void> {
  const path = resolve(root(), "README.md");
  if (await stat(path).then(() => true).catch(() => false)) return;
  await writeFile(path, `# Kura reviewed recordings

Recordings moved here by Kura after their review was finished. Kura no longer lists them; their
clips stay in the library. Each \`originals/<video id>/\` holds:

- the original file, byte-identical (\`sha256\` in \`receipts.jsonl\`);
- \`catalog.json\`: the video row, the review (highlights, decisions), label answers and clip feedback
  exactly as they were before removal;
- \`training-snapshot/\`: the highlight model's stored features and decisions for it.

\`receipts.jsonl\` has a "copied" line (checksum verified on the NAS) and a "removed" line (gone
from Kura) per recording. The video id is the key everywhere: \`recording_clip_feedback.video_id\`
in Kura's database and \`data/recording-training-snapshots/<video id>/\` keep referring to it.

## Getting one back

Copy the file into a folder Kura scans and rescan it. It comes back with a new video id; its
labels stay under the old id, so join them through this folder (or the sha256 / file name).
`);
}

/** Moves one finished recording to the NAS. Throws (and leaves everything in place) when it cannot. */
export async function archiveRecording(videoId: number): Promise<{ video_id: number; bytes: number; path: string }> {
  if (env.DEMO_MODE) throw new BadRequestError("Recordings are not moved to the NAS in demo mode");
  const [review] = await db.select().from(recordingReviewsTable).where(eq(recordingReviewsTable.videoId, videoId));
  const finished = await db.execute<{ ok: boolean }>(sql`
    SELECT ${await archivable()} AS ok FROM recording_reviews r JOIN videos v ON v.id = r.video_id WHERE r.video_id = ${videoId}`);
  if (!review || !finished[0]?.ok) throw new BadRequestError("Only GoondVR recordings with a finished review move to the NAS");
  const video = await videosService.findById(videoId);
  const owned = (await goondvr.recordings()).find((recording) => recording.name === video.file_name);
  if (owned?.active) throw new BadRequestError("GoondVR is still recording this file");
  await assertNas(video.file_path);
  await writeReadme();

  const before = await stat(video.file_path, { bigint: true });
  const folder = resolve(root(), "originals", String(videoId));
  await mkdir(folder, { recursive: true });
  const destination = resolve(folder, video.file_name);
  const checksum = await verifiedCopy(video.file_path, destination);

  await preserveRecordingReviewsBeforeDeletion([videoId]);
  const local = resolve(snapshots(), String(videoId));
  if (await stat(local).then(() => true).catch(() => false)) await cp(local, resolve(folder, "training-snapshot"), { recursive: true, force: true });
  const [labels, feedback] = await Promise.all([
    db.execute(sql`SELECT * FROM recording_label_tasks WHERE video_id = ${videoId}`),
    db.execute(sql`SELECT * FROM recording_clip_feedback WHERE video_id = ${videoId}`),
  ]);
  await writeFile(resolve(folder, "catalog.json"), `${JSON.stringify({ video, review, labels, feedback }, null, 2)}\n`);
  const bytes = Number(before.size);
  await journal({ stage: "copied", video_id: videoId, file_name: video.file_name, kura_file_hash: video.file_hash, sha256: checksum, bytes, nas_path: destination });

  // The file must still be the one that was copied, and the catalog row the one that was read.
  await videosBulkService.bulkDelete([videoId], {
    catalogGuard: sql`file_path = ${video.file_path} AND file_size_bytes = ${video.file_size_bytes}`,
    removeSource: async (entry) => {
      const now = await stat(entry.filePath, { bigint: true });
      if (now.size !== before.size || now.mtimeNs !== before.mtimeNs || now.ino !== before.ino)
        throw new Error("The recording changed after it was copied; the original is kept");
      if (owned && !(await goondvr.deleteRecording(owned.id))) throw new Error("GoondVR could not delete the recording");
    },
  });
  if (await stat(video.file_path).then(() => true).catch(() => false)) throw new Error("The original is still on disk after removal");
  // Like a library delete: enrichment suggestions point at the video without a foreign key.
  const { enrichmentService } = await import("@/modules/enrichment/enrichment.service");
  await enrichmentService.deleteForEntity("scene", videoId);
  await journal({ stage: "removed", video_id: videoId, bytes });
  return { video_id: videoId, bytes, path: destination };
}

async function drain(): Promise<void> {
  if (state.running) return;
  state.running = true;
  try {
    // One at a time: the NAS link is the bottleneck, and receipts stay in order.
    for (let id = state.queue.shift(); id !== undefined; id = state.queue.shift()) {
      try {
        const moved = await archiveRecording(id);
        state.moved += 1;
        state.movedBytes += moved.bytes;
        state.failed = state.failed.filter((entry) => entry.video_id !== id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        state.failed = [...state.failed.filter((entry) => entry.video_id !== id), { video_id: id, error: message }];
        logger.warn({ err: error, videoId: id }, "Could not move the recording to the NAS; it stays here");
      }
    }
  } finally {
    state.running = false;
  }
}

/** Queues recordings to move in the background; already queued ones are not added twice. */
export function queueArchive(ids: readonly number[]): number {
  const fresh = ids.filter((id) => !state.queue.includes(id));
  state.queue.push(...fresh);
  void drain();
  return fresh.length;
}

async function eligible(): Promise<{ video_id: number; bytes: number }[]> {
  const rows = await db.execute<{ video_id: number; bytes: number }>(sql`
    SELECT r.video_id, v.file_size_bytes AS bytes FROM recording_reviews r JOIN videos v ON v.id = r.video_id
    WHERE ${await archivable()} ORDER BY r.video_id`);
  return rows.map((row) => ({ video_id: Number(row.video_id), bytes: Number(row.bytes) }));
}

/** Queues every finished recording still on this disk. */
export async function archiveAllFinished(): Promise<{ queued: number }> {
  if (env.DEMO_MODE) throw new BadRequestError("Recordings are not moved to the NAS in demo mode");
  if (!(await nasAvailable())) throw new AppError(503, `The NAS archive folder ${root()} is not available. Is the NAS mounted?`);
  return { queued: queueArchive((await eligible()).map((row) => row.video_id)) };
}

/** @internal The safety-critical steps, for tests. */
export const archiveSteps = { verifiedCopy, assertNas };

export async function archiveStatus(): Promise<ArchiveStatus> {
  const waiting = env.DEMO_MODE ? [] : await eligible();
  return {
    nas_available: !env.DEMO_MODE && (await nasAvailable()),
    root: root(),
    eligible: { count: waiting.length, bytes: waiting.reduce((sum, row) => sum + row.bytes, 0) },
    running: state.running,
    queued: state.queue.length,
    moved: { count: state.moved, bytes: state.movedBytes },
    failed: state.failed,
  };
}
