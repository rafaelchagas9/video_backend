import { describe, expect, it, spyOn } from "bun:test";
import { mkdtemp, rm, writeFile, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RECORDING_AUDIO_PIN, readRecordingAudioCache, recordingAudioCacheName, recordingAudioWindows, type RecordingAudioIdentity } from "@/modules/recordings/recordings.audio-cache";
const identity: RecordingAudioIdentity = { video_id: 42, analyzed_at: "2026-10-10T00:00:00.000Z", index_model_revision: "siglip2/so400m-patch16-256", storyboard_generated_at: "2026-10-09T00:00:00.000Z", frame_count: 12, audio_model_revision: RECORDING_AUDIO_PIN };
const proposals = [{ id: "c1", start_seconds: 0, end_seconds: 60, score: .8 }, { id: "c2", start_seconds: 60, end_seconds: 80, score: .7 }];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "recording-audio-cache-")), source = join(root, "source.fixture");
  await writeFile(source, "synthetic source metadata fixture"); const info = await stat(source, { bigint: true });
  const embedding = Array(768).fill(0); embedding[0] = 1;
  const ready = { ...proposals[0]!, status: "ready", embedding, windows_seconds: recordingAudioWindows(proposals[0]!), decoded_samples: [320000, 320000] };
  const cache = { schema_version: 1, ...identity, source_fingerprint: { size_bytes: Number(info.size), mtime_ns: info.mtimeNs.toString() }, proposals: [ready, { ...proposals[1]!, status: "failed" }] };
  const input = { identity, proposals, source: { path: source, sizeBytes: Number(info.size) }, cacheRoot: root };
  const save = () => writeFile(join(root, recordingAudioCacheName(identity)), JSON.stringify(cache));
  return { root, source, cache, ready, input, save };
}
describe("private original-proposal audio cache", () => {
  it("loads one valid unit embedding while failed and missing proposals use fallback", async () => {
    const f = await fixture(); try { await f.save(); const result = await readRecordingAudioCache(f.input); expect(result.status).toBe("ready"); expect([...result.embeddings.keys()]).toEqual(["c1"]); expect(result.embeddings.get("c1")?.length).toBe(768); expect(recordingAudioWindows({ start_seconds: 0, end_seconds: 19 })).toBeNull(); expect(recordingAudioWindows({ start_seconds: 0, end_seconds: 20 })).toEqual([[0, 20], [0, 20]]); } finally { await rm(f.root, { recursive: true, force: true }); }
  });
  it("fails closed for changed analysis, original ranges, model pin and index generation", async () => {
    const f = await fixture(); try {
      await f.save(); expect((await readRecordingAudioCache({ ...f.input, identity: { ...identity, analyzed_at: "2026-10-10T01:00:00.000Z" } })).embeddings.size).toBe(0);
      expect((await readRecordingAudioCache({ ...f.input, proposals: [{ ...proposals[0]!, end_seconds: 59 }, proposals[1]!] })).embeddings.size).toBe(0);
      f.cache.audio_model_revision = "wrong"; await f.save(); expect((await readRecordingAudioCache(f.input)).embeddings.size).toBe(0);
      f.cache.audio_model_revision = RECORDING_AUDIO_PIN; f.cache.storyboard_generated_at = "2026-10-10T00:00:00.000Z"; await f.save(); expect((await readRecordingAudioCache(f.input)).embeddings.size).toBe(0);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
  it("rejects incomplete decoding, shifted sampling and non-unit vectors", async () => {
    const f = await fixture(); try {
      f.ready.decoded_samples = [1000, 320000]; await f.save(); expect((await readRecordingAudioCache(f.input)).embeddings.size).toBe(0);
      f.ready.decoded_samples = [320000, 320000]; f.ready.windows_seconds = [[0, 20], [40, 60]]; await f.save(); expect((await readRecordingAudioCache(f.input)).embeddings.size).toBe(0);
      f.ready.windows_seconds = recordingAudioWindows(proposals[0]!); f.ready.embedding = Array(768).fill(0); await f.save(); expect((await readRecordingAudioCache(f.input)).embeddings.size).toBe(0);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
  it("invalidates same-size source replacement after the bounded metadata cache expires", async () => {
    const f = await fixture(); let clock: ReturnType<typeof spyOn> | undefined;
    try { await f.save(); expect((await readRecordingAudioCache(f.input)).embeddings.size).toBe(1); await utimes(f.source, new Date(0), new Date(0)); const now = Date.now(); clock = spyOn(Date, "now").mockImplementation(() => now + 6000); const result = await readRecordingAudioCache(f.input); expect(result.status).toBe("source-changed"); expect(result.embeddings.size).toBe(0); }
    finally { clock?.mockRestore(); await rm(f.root, { recursive: true, force: true }); }
  });
  it("returns numeric fallback when the cache is absent", async () => { const f = await fixture(); try { const result = await readRecordingAudioCache(f.input); expect(result.status).toBe("missing"); expect(result.embeddings.size).toBe(0); } finally { await rm(f.root, { recursive: true, force: true }); } });
});
