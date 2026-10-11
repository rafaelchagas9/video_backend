import { afterEach, expect, it, mock, spyOn } from "bun:test";
import { mkdtemp, rm, writeFile, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as children from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { observeRecordingAudioCompletion, drainPendingRecordingAudioJobs, launchRecordingAudioWorker, RECORDING_AUDIO_PIN, recordingAudioCacheName, type RecordingAudioWorkerLaunch } from "@/modules/recordings/recordings.audio-cache";
const roots: string[] = [], spies: ReturnType<typeof spyOn>[] = [];
afterEach(async () => { for (const spy of spies.splice(0)) spy.mockRestore(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(videoId = 42) {
  const root = await mkdtemp(join(tmpdir(), "recording-audio-resume-")); roots.push(root);
  const source = join(root, "source.fixture"); await writeFile(source, "disposable numeric fixture"); const info = await stat(source, { bigint: true });
  const identity = { schema_version: 1, video_id: videoId, analyzed_at: "2026-10-10T00:00:00.000Z", index_model_revision: "siglip2/so400m-patch16-256", storyboard_generated_at: "2026-10-09T00:00:00.000Z", frame_count: 12, audio_model_revision: RECORDING_AUDIO_PIN, source_fingerprint: { size_bytes: Number(info.size), mtime_ns: info.mtimeNs.toString() } };
  const job = { identity, source_path: source, proposals: [{ id: "c1", start_seconds: 0, end_seconds: 60 }] };
  const path = join(root, recordingAudioCacheName(identity)), raw = JSON.stringify(job); await writeFile(path, raw);
  return { root, source, identity, job, path, raw };
}
it("missing jobs and demo mode short-circuit without launching", async () => {
  const launch = mock(async (_input: RecordingAudioWorkerLaunch) => true); expect(await drainPendingRecordingAudioJobs({ jobsRoot: "/nonexistent/numeric-jobs-fixture", launch })).toBe(false);
  const f = await fixture(); expect(await drainPendingRecordingAudioJobs({ jobsRoot: f.root, demoMode: true, launch })).toBe(false); expect(launch).not.toHaveBeenCalled();
});
it("explicit drain launches once and preserves all existing private jobs", async () => {
  const f = await fixture(), other = { ...f.job, identity: { ...f.identity, video_id: 43 } }; const second = join(f.root, recordingAudioCacheName(other.identity)); await writeFile(second, JSON.stringify(other));
  const launch = mock(async (_input: RecordingAudioWorkerLaunch) => true); expect(await drainPendingRecordingAudioJobs({ jobsRoot: f.root, cacheRoot: join(f.root, "cache"), launch })).toBe(true);
  expect(launch).toHaveBeenCalledTimes(1); expect([f.path, second]).toContain(launch.mock.calls[0]![0].jobPath); expect(await Bun.file(f.path).text()).toBe(f.raw); expect((await stat(second)).isFile()).toBe(true);
});
it("stale source, wrong model, malformed ranges and wrong hashed names never launch", async () => {
  const f = await fixture(), launch = mock(async (_input: RecordingAudioWorkerLaunch) => true);
  await utimes(f.source, new Date(0), new Date(0)); expect(await drainPendingRecordingAudioJobs({ jobsRoot: f.root, launch })).toBe(false);
  const info = await stat(f.source, { bigint: true }); f.job.identity.source_fingerprint.mtime_ns = info.mtimeNs.toString();
  for (const bad of [{ ...f.job, identity: { ...f.job.identity, audio_model_revision: "wrong" } }, { ...f.job, proposals: [{ id: "c1", start_seconds: 0, end_seconds: 19 }] }]) {
    await writeFile(f.path, JSON.stringify(bad)); expect(await drainPendingRecordingAudioJobs({ jobsRoot: f.root, launch })).toBe(false);
  }
  await writeFile(f.path, "not JSON"); await writeFile(join(f.root, "0".repeat(64) + ".json"), JSON.stringify(f.job));
  expect(await drainPendingRecordingAudioJobs({ jobsRoot: f.root, launch })).toBe(false); expect(launch).not.toHaveBeenCalled(); expect((await stat(f.path)).isFile()).toBe(true);
});
it("launcher failure does not cause a second attempt or remove checkpoints", async () => {
  const f = await fixture(), other = { ...f.job, identity: { ...f.identity, video_id: 43 } }; await writeFile(join(f.root, recordingAudioCacheName(other.identity)), JSON.stringify(other));
  const launch = mock(async () => { throw new Error("synthetic launch failure"); });
  await expect(drainPendingRecordingAudioJobs({ jobsRoot: f.root, launch })).rejects.toThrow("synthetic launch failure"); expect(launch).toHaveBeenCalledTimes(1); expect((await stat(f.path)).isFile()).toBe(true);
});
it("shared launcher supplies the finite300-second budget and low priority", async () => {
  const f = await fixture(), worker = join(f.root, "worker.fixture"), python = join(f.root, "python.fixture"); await writeFile(worker, "fixture"); await writeFile(python, "fixture");
  const child = { on: mock(() => undefined), unref: mock(() => undefined) };
  const spawn = spyOn(children, "spawn").mockImplementation((() => child) as unknown as typeof children.spawn); spies.push(spawn);
  expect(await launchRecordingAudioWorker({ jobPath: f.path, cacheRoot: join(f.root, "cache"), workerPath: worker, pythonPath: python })).toBe(true);
  expect(spawn).toHaveBeenCalledTimes(1); expect(spawn.mock.calls[0]![0]).toBe("/usr/bin/nice"); expect(spawn.mock.calls[0]![1]).toEqual(["-n", "10", "/usr/bin/ionice", "-c", "3", python, worker, f.path, "--cache-root", join(f.root, "cache"), "--seconds", "300"]); expect(child.unref).toHaveBeenCalledTimes(1);
});

it("one close emits only validated changed video IDs across a multi-generation drain", () => {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough() }), notify = mock((_ids: number[]) => undefined);
  observeRecordingAudioCompletion(child as unknown as children.ChildProcess, notify);
  child.stdout.write('{"video_id":7,"ready":1}\n{"event":"recordings:model-ready","video_ids":[8,');
  child.stdout.write('7,8]}\n');
  expect(notify).not.toHaveBeenCalled(); child.emit("close", 0); child.emit("close", 0);
  expect(notify).toHaveBeenCalledTimes(1); expect(notify.mock.calls[0]![0]).toEqual([7, 8]);
});
it("busy, unchanged, malformed or oversized worker output cannot publish an event", () => {
  for (const output of ['{"status":"deferred-numeric-fallback"}\n', '{"video_id":7,"ready":1}\n', '{"event":"recordings:model-ready","video_ids":[7,"8"]}\n', 'x'.repeat(65537) + '\n{"event":"recordings:model-ready","video_ids":[7]}\n']) {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough() }), notify = mock((_ids: number[]) => undefined);
    observeRecordingAudioCompletion(child as unknown as children.ChildProcess, notify); child.stdout.write(output); child.emit("close", 0);
    expect(notify).not.toHaveBeenCalled();
  }
});
