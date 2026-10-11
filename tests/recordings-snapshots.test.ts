import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecordingTrainingSnapshots, encodeSnapshotFeatures, MAX_SNAPSHOT_FEATURE_BYTES, SNAPSHOT_DIMENSION,
  type SnapshotIndex, type SnapshotReview } from "@/modules/recordings/recordings.snapshots";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function archive() {
  const root = await mkdtemp(join(tmpdir(), "recording-snapshots-")); roots.push(root);
  return new RecordingTrainingSnapshots(root);
}
const index: SnapshotIndex = { modelRevision: "siglip2/so400m-patch16-256", storyboardGeneratedAt: "2026-10-08T00:00:00Z",
  indexedAt: "2026-10-08T00:01:00Z", intervalSeconds: 5, frameCount: 2 };
const review: SnapshotReview = { source: { videoId: 1, fileName: "synthetic_2026-10-08_00-00-00.mkv", fileHash: "stored-hash",
  fileSizeBytes: 100, durationSeconds: 10, width: 456, height: 256, codec: "h264", audioCodec: "aac", fps: 30, channel: "synthetic" },
  analyzedAt: "2026-10-08T00:02:00Z", detectorRevision: "probe-v1", status: "proposed", event: "save", curve: [0.2, 0.8], clips: [
    { id: "c1", start_seconds: 1, end_seconds: 4, peak_seconds: 2, keep: true, score: 0.9, label: "test",
      reasons: ["keep_clear"], detected: { start_seconds: 0, end_seconds: 5 }, job_id: 11, output_video_id: 12 },
    { id: "c2", start_seconds: 6, end_seconds: 10, peak_seconds: 7, keep: false, score: 0.6, label: "test" },
  ] };
const frames = () => ({ timestamps: [0, 5.000000123], vectors: [new Float32Array(SNAPSHOT_DIMENSION).fill(0.125), new Float32Array(SNAPSHOT_DIMENSION).fill(-0.5)] });
const manifestPath = (store: RecordingTrainingSnapshots, value = review) => join(store.root, "1", `review-${Date.parse(value.analyzedAt)}.json`);

describe("reviewed recording training snapshots", () => {
  it("preserves exact timestamps, stored vectors, all batch choices, original metadata and output lineage", async () => {
    const store = await archive();
    const manifest = await store.save(review, index, async () => frames());
    expect(JSON.parse(await readFile(manifestPath(store), "utf8"))).toEqual(manifest);
    expect(manifest.clips).toEqual(review.clips);
    expect(manifest.source).toEqual(review.source);
    const bytes = await readFile(join(store.root, "1", manifest.features.file));
    expect(bytes.subarray(0, 8).toString()).toBe("KURAFEAT");
    const offset = 12 + bytes.readUInt32LE(8);
    expect(bytes.readDoubleLE(offset + 8)).toBe(frames().timestamps[1]);
    expect(bytes.readFloatLE(offset + 16)).toBe(0.125);
    expect(bytes.readFloatLE(offset + 16 + SNAPSHOT_DIMENSION * 4)).toBe(-0.5);
    expect(manifest.features.bytes).toBe(bytes.length);
  });

  it("reuses immutable features and rewrites only the small manifest on repeated Save", async () => {
    const store = await archive(); let loads = 0;
    const load = async () => { loads++; return frames(); };
    const first = await store.save(review, index, load);
    const next = { ...review, clips: review.clips.map((clip) => ({ ...clip, keep: false, reasons: ["skip_boring"] })) };
    const second = await store.save(next, index, load);
    expect(loads).toBe(1);
    expect(second.features).toEqual(first.features);
    expect(JSON.parse(await readFile(manifestPath(store), "utf8")).clips).toEqual(next.clips);
    expect((await readdir(join(store.root, "1"))).filter((name) => name.endsWith(".bin"))).toHaveLength(1);
  });

  it("retains the previous review on feature failure and allows a later retry", async () => {
    const store = await archive();
    await store.save(review, index, async () => frames());
    const before = await readFile(manifestPath(store));
    const newReview = { ...review, analyzedAt: "2026-10-08T00:03:00Z" };
    const newIndex = { ...index, indexedAt: "2026-10-08T00:02:00Z" };
    await expect(store.save(newReview, newIndex, async () => { throw new Error("synthetic read failure"); })).rejects.toThrow("synthetic read failure");
    expect(await readFile(manifestPath(store))).toEqual(before);
    await store.save(newReview, newIndex, async () => frames());
    expect((await readdir(join(store.root, "1"))).filter((name) => name.endsWith(".tmp"))).toHaveLength(0);
  });

  it("refuses stale features for the same saved analysis and keeps its previous snapshot", async () => {
    const store = await archive();
    const first = await store.save(review, index, async () => frames());
    await expect(store.save(review, { ...index, indexedAt: "2026-10-08T00:03:00Z" }, async () => frames())).rejects.toThrow("original snapshot has been preserved");
    expect(JSON.parse(await readFile(manifestPath(store), "utf8")).features).toEqual(first.features);
  });

  it("rejects missing, malformed, incomplete or oversized features before publishing a review", async () => {
    const store = await archive();
    await expect(store.save(review, { ...index, frameCount: 0 }, async () => frames())).rejects.toThrow("compatible visual index");
    const big = Math.floor(MAX_SNAPSHOT_FEATURE_BYTES / (8 + SNAPSHOT_DIMENSION * 4)) + 1;
    let loads = 0;
    await expect(store.save(review, { ...index, frameCount: big }, async () => { loads++; return frames(); })).rejects.toThrow("64 MiB");
    expect(loads).toBe(0);
    await expect(store.save({ ...review, source: { ...review.source, durationSeconds: 60 } }, index, async () => frames())).rejects.toThrow("does not cover");
    expect(() => encodeSnapshotFeatures("id", index, { ...frames(), timestamps: [0] })).toThrow("frame counts changed");
    expect(() => encodeSnapshotFeatures("id", index, { ...frames(), timestamps: [5, 0] })).toThrow("out of order");
    expect(() => encodeSnapshotFeatures("id", index, { ...frames(), vectors: [new Float32Array(1), new Float32Array(1)] })).toThrow("dimensions");
    const bad = frames(); bad.vectors[0]![0] = NaN;
    expect(() => encodeSnapshotFeatures("id", index, bad)).toThrow("non-finite");
  });

  it("verifies archived feature checksums before allowing original removal", async () => {
    const store = await archive();
    const manifest = await store.save(review, index, async () => frames());
    const path = join(store.root, "1", manifest.features.file);
    const bytes = await readFile(path); bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
    await writeFile(path, bytes);
    await expect(store.save({ ...review, event: "before-delete" }, index, async () => frames())).rejects.toThrow("original must be retained");
    expect(JSON.parse(await readFile(manifestPath(store), "utf8")).event).toBe("save");
  });

  it("serializes concurrent saves and refuses an incompatible immutable receipt", async () => {
    const store = await archive(); let loads = 0;
    const load = async () => { loads++; return frames(); };
    const [, last] = await Promise.all([store.save(review, index, load), store.save({ ...review, event: "before-delete" }, index, load)]);
    expect(loads).toBe(1);
    expect(JSON.parse(await readFile(manifestPath(store), "utf8")).event).toBe("before-delete");
    await writeFile(join(store.root, "1", `${last.features.file}.json`), JSON.stringify({ identity: "wrong" }));
    await expect(store.save(review, index, load)).rejects.toThrow("incomplete or incompatible");
    expect(loads).toBe(1);
  });
  it("freezes validated numeric audio alongside original decisions and preserves it when source access is gone", async () => {
    const store = await archive(), embedding = Array(768).fill(0); embedding[0] = 1;
    const audio = { modelRevision: "google/embeddinggemma-2@914f7f89142e33e77833254d9c9b90c3cef7303b", proposals: [{ id: "c1", start_seconds: 0, end_seconds: 5, embedding }] };
    const first = await store.save(review, index, async () => frames(), async () => audio);
    expect(first.audio_features?.bytes).toBeLessThan(1024 * 1024);
    const bytes = await readFile(join(store.root, "1", first.audio_features!.file));
    expect(JSON.parse(bytes.toString())).toEqual(audio);
    expect(bytes.toString()).not.toContain("source_path");
    const deleted = await store.save({ ...review, event: "before-delete" }, index, async () => { throw new Error("features already frozen"); });
    expect(deleted.audio_features).toEqual(first.audio_features);
    expect(deleted.clips).toEqual(review.clips);
  });
  it("retains the original when an archived audio checksum fails or incoming ranges are incompatible", async () => {
    const store = await archive(), embedding = Array(768).fill(0); embedding[0] = 1;
    const audio = { modelRevision: "google/embeddinggemma-2@914f7f89142e33e77833254d9c9b90c3cef7303b", proposals: [{ id: "c1", start_seconds: 0, end_seconds: 5, embedding }] };
    const first = await store.save(review, index, async () => frames(), async () => audio), before = await readFile(manifestPath(store));
    await expect(store.save(review, index, async () => frames(), async () => ({ ...audio, proposals: [{ ...audio.proposals[0]!, end_seconds: 9 }] }))).rejects.toThrow("original proposals");
    expect(await readFile(manifestPath(store))).toEqual(before);
    const path = join(store.root, "1", first.audio_features!.file), bytes = await readFile(path); bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1; await writeFile(path, bytes);
    await expect(store.save({ ...review, event: "before-delete" }, index, async () => frames())).rejects.toThrow("original must be retained");
    expect(await readFile(manifestPath(store))).toEqual(before);
  });

});
