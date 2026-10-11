/** Numeric audio cache only: source metadata is checked, source contents are never opened here. */
import { createHash } from "node:crypto";
import { readFile, stat, mkdir, writeFile, chmod, rename, readdir } from "node:fs/promises";
import { join, resolve, isAbsolute } from "node:path";
import { spawn } from "node:child_process";
import { z } from "zod";
import { env } from "@/config/env";
import type { ModelProposal } from "./recordings.model";

export const RECORDING_AUDIO_PIN = "google/embeddinggemma-2@914f7f89142e33e77833254d9c9b90c3cef7303b";
export const RECORDING_AUDIO_DIMENSION = 768;
const MAX_PROPOSALS = 60, MAX_BYTES = 1024 * 1024;
export interface RecordingAudioIdentity {
  video_id: number; analyzed_at: string; index_model_revision: string; storyboard_generated_at: string; frame_count: number; audio_model_revision: string;
}
export interface RecordingAudioSource { path: string; sizeBytes: number }
const sourceSchema = z.object({ size_bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), mtime_ns: z.string().regex(/^\d+$/) });
const cacheSchema = z.object({
  schema_version: z.literal(1), video_id: z.number().int().positive(), analyzed_at: z.string().datetime(),
  index_model_revision: z.string(), storyboard_generated_at: z.string().datetime(), frame_count: z.number().int().nonnegative().max(8000),
  audio_model_revision: z.literal(RECORDING_AUDIO_PIN), source_fingerprint: sourceSchema,
  proposals: z.array(z.object({ id: z.string().min(1).max(100), start_seconds: z.number().finite().nonnegative(), end_seconds: z.number().finite().positive(),
    status: z.enum(["ready", "failed"]), embedding: z.array(z.number().finite()).length(RECORDING_AUDIO_DIMENSION).optional(),
    windows_seconds: z.array(z.tuple([z.number().finite(), z.number().finite()])).length(2).optional(),
    decoded_samples: z.array(z.number().int().nonnegative()).length(2).optional(),
  })).max(MAX_PROPOSALS),
});
export function recordingAudioCacheName(identity: RecordingAudioIdentity): string {
  return createHash("sha256").update(JSON.stringify([identity.video_id, identity.analyzed_at, identity.index_model_revision, identity.storyboard_generated_at, identity.frame_count, identity.audio_model_revision])).digest("hex") + ".json";
}
export function recordingAudioWindows(row: Pick<ModelProposal, "start_seconds" | "end_seconds">): number[][] | null {
  const a = row.start_seconds, b = row.end_seconds;
  if (b - a < 20) return null;
  return [1 / 3, 2 / 3].map((fraction) => { const start = Math.round(Math.max(a, Math.min(a + (b - a) * fraction - 10, b - 20)) * 1000) / 1000; return [start, start + 20]; });
}
const sourceStats = new Map<string, { checked: number; value: z.infer<typeof sourceSchema> | null }>();
async function sourceFingerprint(source: RecordingAudioSource, fresh = false): Promise<z.infer<typeof sourceSchema> | null> {
  const cached = sourceStats.get(source.path);
  if (!fresh && cached && Date.now() - cached.checked < 5000) return cached.value?.size_bytes === source.sizeBytes ? cached.value : null;
  let value: z.infer<typeof sourceSchema> | null = null;
  try { const info = await stat(source.path, { bigint: true }); if (info.isFile() && info.size <= BigInt(Number.MAX_SAFE_INTEGER) && Number(info.size) === source.sizeBytes) value = { size_bytes: Number(info.size), mtime_ns: info.mtimeNs.toString() }; } catch { /* Missing/changed sources use the numeric classifier. */ }
  sourceStats.set(source.path, { checked: Date.now(), value });
  if (sourceStats.size > 32) sourceStats.delete(sourceStats.keys().next().value!);
  return value;
}
const decoded = new Map<string, { identity: string; cache: z.infer<typeof cacheSchema> }>();
export interface RecordingAudioCacheResult { embeddings: Map<string, number[]>; fingerprint: string; status: "ready" | "missing" | "invalid" | "source-changed" }
export async function readRecordingAudioCache(input: { identity: RecordingAudioIdentity; proposals: readonly ModelProposal[]; source?: RecordingAudioSource; cacheRoot?: string; freshSource?: boolean }): Promise<RecordingAudioCacheResult> {
  const empty = (status: RecordingAudioCacheResult["status"], fingerprint: string): RecordingAudioCacheResult => ({ embeddings: new Map(), status, fingerprint });
  const path = join(input.cacheRoot ?? process.env.RECORDINGS_AUDIO_CACHE?.trim() ?? "./data/models/recording-audio-cache", recordingAudioCacheName(input.identity));
  try {
    const before = await stat(path), identity = `${path}:${before.mtimeMs}:${before.size}`;
    if (!before.isFile() || before.size > MAX_BYTES) return empty("invalid", identity);
    let cache = decoded.get(path)?.identity === identity ? decoded.get(path)!.cache : null;
    if (!cache) {
      const content = await readFile(path, "utf8"), after = await stat(path);
      if (after.mtimeMs !== before.mtimeMs || after.size !== before.size) return empty("invalid", identity);
      cache = cacheSchema.parse(JSON.parse(content)); decoded.set(path, { identity, cache });
      if (decoded.size > 32) decoded.delete(decoded.keys().next().value!);
    }
    if (Object.entries(input.identity).some(([key, value]) => cache![key as keyof RecordingAudioIdentity] !== value)) return empty("invalid", identity);
    if (!input.source) return empty("source-changed", identity + ":no-source");
    const current = await sourceFingerprint(input.source, input.freshSource);
    const fingerprint = identity + ":" + JSON.stringify(current);
    if (!current || current.size_bytes !== cache.source_fingerprint.size_bytes || current.mtime_ns !== cache.source_fingerprint.mtime_ns) return empty("source-changed", fingerprint);
    const originals = new Map(input.proposals.filter((row) => !row.id.startsWith("added-")).map((row) => [row.id, row]));
    if (new Set(cache.proposals.map((row) => row.id)).size !== cache.proposals.length) return empty("invalid", fingerprint);
    const embeddings = new Map<string, number[]>();
    for (const row of cache.proposals) {
      const original = originals.get(row.id), windows = original ? recordingAudioWindows(original) : null;
      if (!original || row.start_seconds !== original.start_seconds || row.end_seconds !== original.end_seconds) return empty("invalid", fingerprint);
      if (row.status !== "ready") continue;
      if (!windows || !row.embedding || !row.windows_seconds || !row.decoded_samples || row.decoded_samples.some((count) => count < 316000 || count > 336000) || row.windows_seconds.some((window, i) => window.some((value, j) => Math.abs(value - windows[i]![j]!) > .001))) continue;
      const norm = Math.sqrt(row.embedding.reduce((sum, value) => sum + value * value, 0));
      if (Math.abs(norm - 1) > .01) continue;
      embeddings.set(row.id, row.embedding);
    }
    return { embeddings, fingerprint, status: "ready" };
  } catch { return empty("missing", path + ":missing"); }
}
export interface RecordingAudioWorkerLaunch {
  jobPath: string; cacheRoot: string; workerPath?: string; pythonPath?: string;
  /** Numeric-only completion callback; defaults to the authenticated SSE bus. */
  onReady?: (videoIds: number[]) => void;
}
/** The same finite worker is used for a new analysis and an explicit processing resume. */
export async function launchRecordingAudioWorker(input: RecordingAudioWorkerLaunch): Promise<boolean> {
  if (env.DEMO_MODE) return false;
  const worker = resolve(input.workerPath ?? "./vision-lab/model_completion/audio_cache_worker.py");
  const python = resolve(input.pythonPath ?? "./vision-lab/colab_audio_pilot/.venv-v2/bin/python");
  if (!(await stat(worker).catch(() => null))?.isFile() || !(await stat(python).catch(() => null))?.isFile()) return false;
  const child = spawn("/usr/bin/nice", ["-n", "10", "/usr/bin/ionice", "-c", "3", python, worker, resolve(input.jobPath), "--cache-root", resolve(input.cacheRoot), "--seconds", "300"], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  observeRecordingAudioCompletion(child, input.onReady ?? ((videoIds) => {
    void import("@/modules/events/events.service").then(({ eventsService }) => eventsService.broadcastToAuthenticated({ type: "recordings:model-ready", message: { video_ids: videoIds } })).catch(() => undefined);
  }));
  child.on("error", () => undefined); child.unref(); return true;
}
/** Consume only the worker's final numeric receipt, once at close; discard oversized output. */
export function observeRecordingAudioCompletion(child: Pick<import("node:child_process").ChildProcess, "stdout" | "on">, notify: (videoIds: number[]) => void): void {
  let output = "", overflow = false, delivered = false;
  child.stdout?.on("data", (chunk: Buffer | string) => {
    if (overflow) return;
    output += chunk.toString();
    if (output.length > 64 * 1024) { output = ""; overflow = true; }
  });
  child.on("close", () => {
    if (delivered || overflow) return;
    delivered = true;
    const changed = new Set<number>();
    for (const line of output.split("\n")) {
      try {
        const value = JSON.parse(line);
        if (value?.event !== "recordings:model-ready" || !Array.isArray(value.video_ids) || value.video_ids.length > 4096 || !value.video_ids.every((id: unknown) => typeof id === "number" && Number.isSafeInteger(id) && id > 0)) continue;
        for (const id of value.video_ids) changed.add(id);
      } catch { /* Ordinary progress lines do not contain a completion receipt. */ }
    }
    if (changed.size) notify([...changed].sort((a, b) => a - b));
  });
}
const privateJobSchema = z.object({
  identity: cacheSchema.omit({ proposals: true }), source_path: z.string().min(1).max(4096).refine(isAbsolute),
  proposals: z.array(z.object({ id: z.string().min(1).max(100), start_seconds: z.number().finite().nonnegative(), end_seconds: z.number().finite().positive() }))
    .min(1).max(MAX_PROPOSALS).refine((rows) => new Set(rows.map((row) => row.id)).size === rows.length && rows.every((row) => !row.id.startsWith("added-") && row.end_seconds - row.start_seconds >= 20)),
});
/** Called only by explicit Resume/Start; no boot hook, watcher hook, recurring timer or new job. */
export async function drainPendingRecordingAudioJobs(input: {
  jobsRoot?: string; cacheRoot?: string; workerPath?: string; pythonPath?: string; demoMode?: boolean;
  launch?: (input: RecordingAudioWorkerLaunch) => Promise<boolean>;
} = {}): Promise<boolean> {
  if (env.DEMO_MODE || input.demoMode) return false;
  const jobsRoot = resolve(input.jobsRoot ?? "./data/models/recording-audio-jobs");
  const entries = await readdir(jobsRoot, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  let selected: RecordingAudioWorkerLaunch | null = null;
  for (const entry of entries.filter((entry) => entry.isFile() && /^[a-f0-9]{64}\.json$/.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(jobsRoot, entry.name);
    try {
      const before = await stat(path);
      if (!before.isFile() || before.size > 64 * 1024) continue;
      const job = privateJobSchema.parse(JSON.parse(await readFile(path, "utf8"))), after = await stat(path);
      if (before.mtimeMs !== after.mtimeMs || before.size !== after.size || recordingAudioCacheName(job.identity) !== entry.name) continue;
      const source = await sourceFingerprint({ path: job.source_path, sizeBytes: job.identity.source_fingerprint.size_bytes }, true);
      if (!source || source.mtime_ns !== job.identity.source_fingerprint.mtime_ns) continue;
      // One launch drains all existing valid generations under the Python shared lock and 300s deadline.
      selected = { jobPath: path,
        cacheRoot: resolve(input.cacheRoot ?? process.env.RECORDINGS_AUDIO_CACHE?.trim() ?? "./data/models/recording-audio-cache"),
        ...(input.workerPath ? { workerPath: input.workerPath } : {}), ...(input.pythonPath ? { pythonPath: input.pythonPath } : {}) };
      break;
    } catch { /* Retain stale/malformed private jobs; never substitute a different identity. */ }
  }
  return selected ? (input.launch ?? launchRecordingAudioWorker)(selected) : false;
}
/** Queue private input for the bounded local worker; HTTP never runs model inference or decoding. */
export async function enqueueRecordingAudio(input: { identity: RecordingAudioIdentity; proposals: readonly ModelProposal[]; source: RecordingAudioSource; cacheRoot?: string; jobsRoot?: string; workerPath?: string; pythonPath?: string }): Promise<boolean> {
  if (env.DEMO_MODE) return false;
  const proposals = input.proposals.filter((row) => !row.id.startsWith("added-") && recordingAudioWindows(row)).map(({ id, start_seconds, end_seconds }) => ({ id, start_seconds, end_seconds }));
  if (!proposals.length || proposals.length > MAX_PROPOSALS) return false;
  const fingerprint = await sourceFingerprint(input.source); if (!fingerprint) return false;
  const jobsRoot = resolve(input.jobsRoot ?? "./data/models/recording-audio-jobs");
  const cacheRoot = resolve(input.cacheRoot ?? process.env.RECORDINGS_AUDIO_CACHE?.trim() ?? "./data/models/recording-audio-cache");
  const worker = resolve(input.workerPath ?? "./vision-lab/model_completion/audio_cache_worker.py"), python = resolve(input.pythonPath ?? "./vision-lab/colab_audio_pilot/.venv-v2/bin/python");
  if (!(await stat(worker).catch(() => null))?.isFile() || !(await stat(python).catch(() => null))?.isFile()) return false;
  await mkdir(jobsRoot, { recursive: true, mode: 0o700 }); await chmod(jobsRoot, 0o700);
  const job = join(jobsRoot, recordingAudioCacheName(input.identity)), temporary = job + `.tmp-${process.pid}`;
  await writeFile(temporary, JSON.stringify({ identity: { schema_version: 1, ...input.identity, source_fingerprint: fingerprint }, source_path: resolve(input.source.path), proposals }) + "\n", { mode: 0o600 }); await rename(temporary, job);
  return launchRecordingAudioWorker({ jobPath: job, cacheRoot, workerPath: worker, pythonPath: python });
}
