/**
 * Durable review training data, independent of media and catalog-row lifetime.
 * Features are immutable and shared by analyses; repeated saves replace only a small manifest.
 * No inference, frame extraction, media access, backfill or cleanup happens here.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { RecordingClip, RecordingProposal } from "@/database/schema";

export const SNAPSHOT_MAGIC = "KURAFEAT";
export const SNAPSHOT_DIMENSION = 1152;
export const MAX_SNAPSHOT_FEATURE_BYTES = 64 * 1024 * 1024;
const PREFIX_BYTES = 12;

export interface SnapshotIndex {
  modelRevision: string;
  storyboardGeneratedAt: string;
  indexedAt: string;
  intervalSeconds: number;
  frameCount: number;
}

export interface SnapshotSource {
  videoId: number;
  fileName: string;
  fileHash: string | null;
  fileSizeBytes: number;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  codec: string | null;
  audioCodec: string | null;
  fps: number | null;
  channel: string | null;
}

export interface SnapshotReview {
  source: SnapshotSource;
  analyzedAt: string;
  detectorRevision: string;
  status: string;
  clips: RecordingClip[];
  /** The proposals as shown before any review; null on reviews older than stored proposals. */
  proposals?: RecordingProposal[] | null;
  /** What the verdicts mean: "triage" is a coarse has-potential call, trims included. */
  labelType?: string;
  /** The Save that confirmed these clips, where the recording sat in the queue, and whether it was an audit pick. */
  save?: { batch: string; queuePosition: number | null; queueSort: string | null; audit: boolean } | null;
  curve: number[];
  event: "save" | "render-requested" | "rendering" | "render-finished" | "before-delete";
}

export interface SnapshotFrames {
  timestamps: number[];
  vectors: Float32Array[];
}

export interface TrainingSnapshotManifest extends SnapshotReview {
  format: "kura-recording-training";
  version: 1;
  updatedAt: string;
  features: { file: string; identity: string; sha256: string; bytes: number; dimension: number; index: SnapshotIndex };
}

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

export function snapshotFeatureIdentity(source: SnapshotSource, index: SnapshotIndex): string {
  // Fixed ordering and all source/index identities prevent reusing an index after a source change.
  return hash(JSON.stringify([source.videoId, source.fileName, source.fileHash, source.fileSizeBytes,
    source.durationSeconds, index.modelRevision, index.storyboardGeneratedAt, index.indexedAt,
    index.intervalSeconds, index.frameCount, SNAPSHOT_DIMENSION]));
}

function validateIndex(index: SnapshotIndex): void {
  if (!index.modelRevision || !Number.isFinite(Date.parse(index.storyboardGeneratedAt)) ||
      !Number.isFinite(Date.parse(index.indexedAt)) || !Number.isFinite(index.intervalSeconds) || index.intervalSeconds <= 0 ||
      !Number.isSafeInteger(index.frameCount) || index.frameCount <= 0)
    throw new Error("The recording has no compatible visual index for a training snapshot");
  if (index.frameCount * (8 + SNAPSHOT_DIMENSION * 4) > MAX_SNAPSHOT_FEATURE_BYTES)
    throw new Error("The recording's training features exceed the 64 MiB snapshot limit");
}

/** Little-endian float64 timestamps followed by float32 vectors; JSON header describes both. */
export function encodeSnapshotFeatures(identity: string, index: SnapshotIndex, frames: SnapshotFrames): Buffer {
  validateIndex(index);
  if (frames.timestamps.length !== index.frameCount || frames.vectors.length !== index.frameCount)
    throw new Error("Visual index frame counts changed; retry Save after indexing finishes");
  const header = Buffer.from(JSON.stringify({ version: 1, identity, index, dimension: SNAPSHOT_DIMENSION,
    timestamps: "float64-le", embeddings: "float32-le" }));
  const out = Buffer.alloc(PREFIX_BYTES + header.length + index.frameCount * (8 + SNAPSHOT_DIMENSION * 4));
  out.write(SNAPSHOT_MAGIC, 0, "ascii");
  out.writeUInt32LE(header.length, 8);
  header.copy(out, PREFIX_BYTES);
  let at = PREFIX_BYTES + header.length;
  let previous = -Infinity;
  for (const timestamp of frames.timestamps) {
    if (!Number.isFinite(timestamp) || timestamp < 0 || timestamp <= previous)
      throw new Error("Visual index timestamps are invalid or out of order");
    out.writeDoubleLE(timestamp, at); at += 8; previous = timestamp;
  }
  for (const vector of frames.vectors) {
    if (vector.length !== SNAPSHOT_DIMENSION) throw new Error("Visual embedding dimensions do not match the snapshot format");
    for (const value of vector) {
      if (!Number.isFinite(value)) throw new Error("Visual embeddings contain a non-finite value");
      out.writeFloatLE(value, at); at += 4;
    }
  }
  return out;
}

/** Flush a new file, publish it atomically, then flush the parent directory. */
async function atomicWrite(path: string, bytes: Buffer): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close(); handle = undefined;
    await rename(temporary, path);
    const directory = await open(join(path, ".."), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    await handle?.close();
    await rm(temporary, { force: true });
  }
}

export class RecordingTrainingSnapshots {
  private readonly pending = new Map<number, Promise<unknown>>();
  constructor(readonly root: string) {}

  /** Serializes writes for a recording. A failed Save never prevents a later retry. */
  async save(review: SnapshotReview, index: SnapshotIndex, loadFrames: () => Promise<SnapshotFrames>): Promise<TrainingSnapshotManifest> {
    const previous = this.pending.get(review.source.videoId) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(() => this.write(review, index, loadFrames));
    this.pending.set(review.source.videoId, operation);
    try { return await operation; }
    finally { if (this.pending.get(review.source.videoId) === operation) this.pending.delete(review.source.videoId); }
  }

  private async write(review: SnapshotReview, index: SnapshotIndex, loadFrames: () => Promise<SnapshotFrames>): Promise<TrainingSnapshotManifest> {
    validateIndex(index);
    if (!Number.isSafeInteger(review.source.videoId) || review.source.videoId <= 0 || !Number.isFinite(Date.parse(review.analyzedAt)))
      throw new Error("The review's identity is invalid for a training snapshot");
    const directory = join(this.root, String(review.source.videoId));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const identity = snapshotFeatureIdentity(review.source, index);
    const manifestPath = join(directory, `review-${Date.parse(review.analyzedAt)}.json`);
    let savedChecksum: string | null = null;
    let savedContext: SnapshotReview["save"] = null;
    const saved = await open(manifestPath, "r").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
    if (saved) {
      try {
        const earlier = JSON.parse(await saved.readFile("utf8")) as TrainingSnapshotManifest;
        if (earlier.features.identity !== identity)
          throw new Error("The source or visual index changed since this review was saved; its original snapshot has been preserved");
        savedChecksum = earlier.features.sha256;
        savedContext = earlier.save ?? null;
      } finally { await saved.close(); }
    }
    const file = `features-${identity}.bin`;
    const path = join(directory, file);
    const receiptPath = `${path}.json`;
    let receipt: { identity: string; sha256: string; bytes: number };
    const existing = await stat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
    if (existing) {
      // Immutable payloads are not read again on every Save; the offline loader verifies their hash.
      const handle = await open(receiptPath, "r");
      try { receipt = JSON.parse(await handle.readFile("utf8")); } finally { await handle.close(); }
      const payloadBytes = index.frameCount * (8 + SNAPSHOT_DIMENSION * 4);
      if (receipt.identity !== identity || !/^[a-f0-9]{64}$/.test(receipt.sha256) || receipt.bytes !== existing.size ||
          receipt.bytes < payloadBytes + PREFIX_BYTES || receipt.bytes > payloadBytes + 65_536 ||
          (savedChecksum !== null && receipt.sha256 !== savedChecksum))
        throw new Error("The saved training features are incomplete or incompatible");
    } else {
      const frames = await loadFrames();
      const duration = review.source.durationSeconds;
      if (duration !== null && Number.isFinite(duration) && duration > 0 &&
          (frames.timestamps.at(-1) ?? -Infinity) + index.intervalSeconds * 2 < duration)
        throw new Error("The stored visual index does not cover the recording; no snapshot was published");
      const bytes = encodeSnapshotFeatures(identity, index, frames);
      receipt = { identity, sha256: hash(bytes), bytes: bytes.length };
      if (savedChecksum !== null && receipt.sha256 !== savedChecksum)
        throw new Error("The replacement training features do not match the earlier snapshot; the original must be retained");
      // Receipt first: a crash cannot leave a published feature file without its checksum.
      await atomicWrite(receiptPath, Buffer.from(JSON.stringify(receipt)));
      await atomicWrite(path, bytes);
    }
    // Removal is rare: verify the bounded payload before allowing an original to be deleted.
    if (review.event === "before-delete" && hash(await readFile(path)) !== receipt.sha256)
      throw new Error("The saved training features failed their checksum; the original must be retained");
    // Render and delete events do not know the Save's context; the last Save's stays.
    const manifest: TrainingSnapshotManifest = { ...review, save: review.save ?? savedContext, format: "kura-recording-training", version: 1,
      updatedAt: new Date().toISOString(), features: { file, ...receipt, dimension: SNAPSHOT_DIMENSION, index } };
    await atomicWrite(manifestPath, Buffer.from(JSON.stringify(manifest)));
    return manifest;
  }
}
