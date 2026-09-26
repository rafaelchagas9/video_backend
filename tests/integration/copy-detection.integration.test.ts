import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type postgres from "postgres";
import type { CopyDetectionService } from "@/modules/copy-detection/copy-detection.service";
import {
  applyTestDatabaseEnv,
  assertTestDatabaseEnvironment,
  migrateTestDatabase,
  startTestDatabase,
} from "../helpers/test-database";

/** A pseudo-random melody (new note every 250 ms): Chromaprint needs changing pitch content. */
function melody(seed: number) {
  // hash of the note index; a plain sin(k) sequence is nearly periodic and aligns everywhere
  const note = (voice: number) =>
    `220*pow(2,floor(24*mod(abs(sin(floor(t*4+${voice})*12.9898+${seed}))*43758.5453,1))/12)`;
  // quoted: the commas inside pow() would otherwise split the filter options
  return `aevalsrc='0.4*sin(2*PI*${note(0)}*t)+0.3*sin(2*PI*1.5*${note(7)}*t)':s=44100:d=90`;
}

async function ffmpeg(args: string[]) {
  const proc = Bun.spawn(["ffmpeg", "-nostdin", "-v", "error", "-y", ...args], {
    stderr: "pipe",
  });
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (code !== 0) throw new Error(`ffmpeg failed: ${stderr}`);
}

describe("copy detection end to end", () => {
  let database: Awaited<ReturnType<typeof startTestDatabase>>;
  let sql: ReturnType<typeof postgres>;
  let closeDatabase: typeof import("@/config/drizzle").closeDrizzleDatabase;
  let service: CopyDetectionService;
  let dir: string;
  const ids: Record<"source" | "clip" | "sharedMusic" | "unrelated", number> = {
    source: 0,
    clip: 0,
    sharedMusic: 0,
    unrelated: 0,
  };
  const signal = new AbortController().signal;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "copy-detection-"));
    const source = join(dir, "source.mkv");
    // moving test pattern + melody: the "livestream"
    await ffmpeg([
      "-f", "lavfi", "-i", "testsrc2=s=1280x720:r=30:d=90",
      "-f", "lavfi", "-i", melody(1),
      "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "libopus", "-shortest", source,
    ]);
    // a 30 s clip, cropped to 80 %, downscaled and re-encoded with another audio codec
    await ffmpeg([
      "-ss", "20", "-t", "30", "-i", source,
      "-vf", "crop=iw*0.8:ih*0.8,scale=-2:480",
      "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-b:a", "96k",
      join(dir, "clip.mp4"),
    ]);
    // same room and same background music, but a different moment of the "performance"
    await ffmpeg([
      "-ss", "40", "-t", "30", "-i", source, "-ss", "10", "-t", "30", "-i", source,
      "-map", "0:v", "-map", "1:a",
      "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", join(dir, "shared-music.mp4"),
    ]);
    await ffmpeg([
      "-f", "lavfi", "-i", "testsrc=s=640x360:r=25:d=60",
      "-f", "lavfi", "-i", melody(7),
      "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest",
      join(dir, "unrelated.mp4"),
    ]);

    database = await startTestDatabase();
    applyTestDatabaseEnv(database);
    const { env } = await import("@/config/env");
    assertTestDatabaseEnvironment(database, env);
    await migrateTestDatabase();
    const postgres = (await import("postgres")).default;
    sql = postgres(database.connectionString);
    const [directory] = await sql<Array<{ id: number }>>`
      INSERT INTO watched_directories (path) VALUES (${dir}) RETURNING id`;
    const files = [
      ["source", "source.mkv", 90],
      ["clip", "clip.mp4", 30],
      ["sharedMusic", "shared-music.mp4", 30],
      ["unrelated", "unrelated.mp4", 60],
    ] as const;
    for (const [key, name, duration] of files) {
      const [row] = await sql<Array<{ id: number }>>`
        INSERT INTO videos (file_path,file_name,directory_id,file_size_bytes,duration_seconds,is_available)
        VALUES (${join(dir, name)},${name},${directory!.id},1,${duration},true) RETURNING id`;
      ids[key] = row!.id;
    }
    ({ closeDrizzleDatabase: closeDatabase } = await import("@/config/drizzle"));
    const { CopyDetectionService } = await import(
      "@/modules/copy-detection/copy-detection.service"
    );
    service = new CopyDetectionService({
      pythonPath: resolve("vision-service/.venv/bin/python"),
      workDir: resolve("vision-service"),
      cacheDir: join(dir, "cache"),
      ffmpegPath: "ffmpeg",
      ffprobePath: "ffprobe",
      fpcalcPath: "fpcalc",
      engineTimeoutMs: 600_000,
    });
  }, 300_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await closeDatabase?.();
    await database?.stop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }, 30_000);

  const pair = async (x: number, y: number) => {
    const [row] = await sql<
      Array<{ verdict: string; status: string | null; coverage_a: number; coverage_b: number }>
    >`SELECT verdict, status, coverage_a, coverage_b FROM video_copy_pairs
      WHERE video_a = ${Math.min(x, y)} AND video_b = ${Math.max(x, y)}`;
    return row;
  };

  it("fingerprints every video once and reuses unchanged fingerprints", async () => {
    for (const id of Object.values(ids))
      expect((await service.process(id, signal)).fingerprint).toBe("extracted");
    expect((await service.process(ids.source, signal)).fingerprint).toBe("reused");
    const videos = await sql<Array<{ id: number; filePath: string; durationSeconds: number }>>`
      SELECT id, file_path AS "filePath", duration_seconds AS "durationSeconds" FROM videos`;
    // fingerprinted but not yet compared: still pending for the sync loop
    expect((await service.processedIds(videos)).size).toBe(0);
  }, 120_000);

  it("verifies the edited clip, rejects shared music over different footage and ignores the rest", async () => {
    const summary = await service.matchPending(signal);
    expect(summary.pending).toBe(4);

    const clip = await pair(ids.source, ids.clip);
    expect(clip).toMatchObject({ verdict: "match", status: "verified" });
    const clipCoverage = ids.clip > ids.source ? clip!.coverage_b : clip!.coverage_a;
    expect(clipCoverage).toBeGreaterThan(0.9);

    expect(await pair(ids.source, ids.sharedMusic)).toMatchObject({
      verdict: "rejected",
      status: null,
    });
    const [{ count }] = await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM video_copy_pairs
      WHERE video_a = ${ids.unrelated} OR video_b = ${ids.unrelated}`;
    expect(count).toBe(0);

    const results = await service.results({ limit: 20, offset: 0 });
    expect(results.items).toHaveLength(1);
    expect(results.items[0]!.video_id).toBe(ids.source);
    expect(results.items[0]!.matches[0]!.assessment.classification).toBe("contained_clip");
  }, 300_000);

  it("has nothing left to compare until a file changes", async () => {
    expect((await service.matchPending(signal)).pending).toBe(0);
    const videos = await sql<Array<{ id: number; filePath: string; durationSeconds: number }>>`
      SELECT id, file_path AS "filePath", duration_seconds AS "durationSeconds" FROM videos`;
    expect((await service.processedIds(videos)).size).toBe(4);

    const later = new Date(Date.now() + 5_000);
    await utimes(join(dir, "clip.mp4"), later, later);
    expect((await service.processedIds(videos)).has(ids.clip)).toBe(false);
    expect((await service.process(ids.clip, signal)).fingerprint).toBe("extracted");
    // decisions about the old file content are gone until the clip is compared again
    expect(await pair(ids.source, ids.clip)).toBeUndefined();
    const again = await service.matchPending(signal);
    expect(again.pending).toBe(1);
    expect(await pair(ids.source, ids.clip)).toMatchObject({ verdict: "match", status: "verified" });
  }, 300_000);
});
