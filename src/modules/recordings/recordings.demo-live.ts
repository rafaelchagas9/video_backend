/**
 * The demo's live view: a demo video remuxed once into fMP4 HLS segments and
 * served as an endless live playlist — a sliding window as long as the one
 * GoondVR keeps while someone watches (two minutes), looping with a
 * discontinuity. It lets the player's live behaviour (rewind, the live edge,
 * reconnecting) be tried without a real broadcast.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { env } from "@/config/env";

/** What GoondVR keeps while watched. */
const WINDOW_SECONDS = 120;
/** Long enough that the loop is rarely noticed, short enough to remux in a moment. */
const SOURCE_SECONDS = 300;

export interface Prepared {
  dir: string;
  durations: number[];
  total: number;
}

const prepared = new Map<number, Promise<Prepared>>();

function prepare(videoId: number, source: string): Promise<Prepared> {
  let job = prepared.get(videoId);
  if (!job) {
    job = build(videoId, source);
    prepared.set(videoId, job);
    job.catch(() => prepared.delete(videoId));
  }
  return job;
}

async function build(videoId: number, source: string): Promise<Prepared> {
  const dir = resolve(process.cwd(), env.DEMO_ASSETS_DIR, "live", String(videoId));
  const playlist = join(dir, "index.m3u8");
  if (!existsSync(playlist)) {
    const work = `${dir}.part`;
    await rm(work, { recursive: true, force: true });
    await mkdir(work, { recursive: true });
    await run("ffmpeg", [
      "-v", "error", "-y", "-i", source, "-t", String(SOURCE_SECONDS),
      "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy",
      "-f", "hls", "-hls_time", "4", "-hls_playlist_type", "vod",
      "-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", "init.mp4",
      "-hls_segment_filename", join(work, "seg-%d.m4s"), join(work, "index.m3u8"),
    ]);
    await rm(dir, { recursive: true, force: true });
    await rename(work, dir);
  }
  const durations = (await readFile(playlist, "utf8"))
    .split("\n")
    .filter((line) => line.startsWith("#EXTINF:"))
    .map((line) => Number.parseFloat(line.slice("#EXTINF:".length)));
  if (!durations.length) throw new Error("The demo stand-in has no segments");
  return { dir, durations, total: durations.reduce((sum, value) => sum + value, 0) };
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((done, failed) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let error = "";
    child.stderr.on("data", (chunk: Buffer) => {
      error = (error + chunk.toString()).slice(-2_000);
    });
    child.on("error", failed);
    child.on("exit", (code) => (code === 0 ? done() : failed(new Error(error.trim() || `${command} exited ${code}`))));
  });
}

/** A per-channel shift, so channels sharing a stand-in are not in lockstep. */
function offsetOf(channelId: string, total: number): number {
  let hash = 0;
  for (const char of channelId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return (hash % Math.max(1, Math.floor(total * 1000))) / 1000;
}

/** The live playlist now: the last two minutes of completed segments of the endless loop. */
export function livePlaylist(channelId: string, { durations, total }: Prepared, now: number): string {
  const count = durations.length;
  const virtual = now / 1000 + offsetOf(channelId, total);
  const loop = Math.floor(virtual / total);
  let position = virtual - loop * total;
  let index = 0;
  while (index < count - 1 && position >= durations[index]!) position -= durations[index++]!;
  // The segment being "received" is not published yet.
  const latest = loop * count + index - 1;
  let first = latest;
  let held = durations[((latest % count) + count) % count]!;
  while (held < WINDOW_SECONDS && first > 0) {
    first -= 1;
    held += durations[first % count]!;
  }
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    `#EXT-X-TARGETDURATION:${Math.ceil(Math.max(...durations))}`,
    `#EXT-X-MEDIA-SEQUENCE:${first}`,
    `#EXT-X-DISCONTINUITY-SEQUENCE:${Math.floor(first / count)}`,
    '#EXT-X-MAP:URI="init-0.mp4"',
  ];
  for (let sequence = first; sequence <= latest; sequence += 1) {
    if (sequence % count === 0 && sequence !== first) lines.push("#EXT-X-DISCONTINUITY", '#EXT-X-MAP:URI="init-0.mp4"');
    lines.push(`#EXTINF:${durations[sequence % count]!.toFixed(3)},`, `seg-${sequence}.m4s`);
  }
  return `${lines.join("\n")}\n`;
}

export type DemoLiveFile =
  | { kind: "starting" }
  | { kind: "missing" }
  | { kind: "file"; contentType: string; body: Buffer | string };

/**
 * One file of a channel's demo live view. The first playlist request starts
 * the remux and answers "starting", like GoondVR does while a stream connects.
 */
export async function demoLiveFile(channelId: string, videoId: number, source: string, file: string): Promise<DemoLiveFile> {
  const job = prepare(videoId, source);
  const ready = await Promise.race([job, new Promise<null>((done) => setTimeout(() => done(null), 1_500))]);
  if (!ready) return { kind: "starting" };
  if (file === "index.m3u8") {
    return { kind: "file", contentType: "application/vnd.apple.mpegurl", body: livePlaylist(channelId, ready, Date.now()) };
  }
  if (/^init-\d+\.mp4$/.test(file)) return { kind: "file", contentType: "video/mp4", body: await readFile(join(ready.dir, "init.mp4")) };
  const sequence = /^seg-(\d+)\.m4s$/.exec(file)?.[1];
  if (sequence === undefined) return { kind: "missing" };
  const path = join(ready.dir, `seg-${Number(sequence) % ready.durations.length}.m4s`);
  if (!existsSync(path)) return { kind: "missing" };
  return { kind: "file", contentType: "video/iso.segment", body: await readFile(path) };
}
