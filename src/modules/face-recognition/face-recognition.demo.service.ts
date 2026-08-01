import type {
  CreatorFaceEmbedding,
  FaceExtractionJob,
  FaceImage,
  VideoFaceDetection,
} from "@/database/schema";
import {
  assertDemoAssetPath,
  demoRepository,
  getDemoSqlite,
  isDemoAssetPath,
  resolveDemoAssetPath,
} from "@/database/demo";
import { NotFoundError } from "@/utils/errors";
import type {
  RawFaceDetection,
  SimilarityMatch,
} from "./face-recognition.types";

const KINDS = {
  embedding: "face-embedding",
  detection: "face-detection",
  job: "face-extraction-job",
  image: "face-image",
} as const;
const DEMO_DATE = new Date("2026-08-01T12:00:00.000Z");

function nextId(kind: string): number {
  return (
    Math.max(
      0,
      ...demoRepository.listResources(kind).map((item) => Number(item.id) || 0)
    ) + 1
  );
}

function vector(value: unknown): number[] {
  if (Array.isArray(value)) return value.map(Number);
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(Number) : [];
  } catch {
    return [];
  }
}

function cosine(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  if (!length) return 0;
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let index = 0; index < length; index += 1) {
    dot += a[index] * b[index];
    aa += a[index] ** 2;
    bb += b[index] ** 2;
  }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}

function cloneDate<T extends Record<string, any>>(value: T): T {
  return {
    ...value,
    ...(value.createdAt ? { createdAt: new Date(value.createdAt) } : {}),
    ...(value.updatedAt ? { updatedAt: new Date(value.updatedAt) } : {}),
    ...(value.startedAt ? { startedAt: new Date(value.startedAt) } : {}),
    ...(value.completedAt ? { completedAt: new Date(value.completedAt) } : {}),
    ...(value.generatedAt ? { generatedAt: new Date(value.generatedAt) } : {}),
  };
}

export class FaceRecognitionDemoService {
  private ensureSeeded(): void {
    if (demoRepository.listResources(KINDS.embedding).length > 0) return;
    const creators = demoRepository.getCreators({ limit: 10_000 }).data;
    for (const creator of creators) {
      for (const [index, source] of creator.face_embeddings.entries()) {
        const payload = source as Record<string, any>;
        const id = creator.id * 1000 + index + 1;
        const embedding: CreatorFaceEmbedding = {
          id,
          creatorId: creator.id,
          embedding: String(payload.embedding ?? "[]"),
          sourceType: "demo_seed",
          sourceVideoId: null,
          sourceTimestampSeconds: null,
          detScore: payload.detScore ?? 0.98,
          isPrimary: Boolean(
            payload.is_primary ?? payload.isPrimary ?? index === 0
          ),
          estimatedAge: payload.estimatedAge ?? null,
          estimatedGender: payload.estimatedGender ?? null,
          thumbnailPath:
            source.thumbnailPath ?? creator.face_thumbnail_path ?? null,
          createdAt: DEMO_DATE,
          updatedAt: DEMO_DATE,
        };
        demoRepository.putResource(KINDS.embedding, id, embedding);
      }
    }
    const seeded = demoRepository.listResources(
      KINDS.embedding
    ) as CreatorFaceEmbedding[];
    for (const [index, embedding] of seeded.slice(0, 3).entries()) {
      const detection: VideoFaceDetection = {
        id: index + 1,
        videoId: index + 1,
        embedding: embedding.embedding,
        timestampSeconds: 12 + index * 7,
        frameIndex: index,
        bboxX1: 0.25,
        bboxY1: 0.15,
        bboxX2: 0.75,
        bboxY2: 0.85,
        detScore: 0.97,
        matchedCreatorId: embedding.creatorId,
        matchConfidence: 0.91 - index * 0.03,
        matchStatus: "pending",
        estimatedAge: embedding.estimatedAge,
        estimatedGender: embedding.estimatedGender,
        createdAt: DEMO_DATE,
        updatedAt: DEMO_DATE,
      };
      demoRepository.putResource(KINDS.detection, detection.id, detection);
    }
  }

  healthCheck() {
    return {
      status: "healthy" as const,
      version: "demo-sqlite-1",
      model: "deterministic-demo",
      onnx_providers: ["demo"],
      embedding_dimension: 8,
      uptime_seconds: 0,
    };
  }

  async addCreatorEmbedding(params: {
    creatorId: number;
    imagePath: string;
    sourceType: string;
    sourceVideoId?: number;
    sourceTimestampSeconds?: number;
    isPrimary?: boolean;
  }): Promise<CreatorFaceEmbedding> {
    this.ensureSeeded();
    const creator = demoRepository.getCreatorById(params.creatorId);
    const existing = await this.getCreatorEmbeddings(params.creatorId);
    if (params.isPrimary) {
      for (const item of existing) {
        demoRepository.putResource(KINDS.embedding, item.id, {
          ...item,
          isPrimary: false,
        });
      }
    }
    const id = nextId(KINDS.embedding);
    const seed = params.creatorId / 100;
    const safeInput = isDemoAssetPath(params.imagePath)
      ? params.imagePath
      : creator.face_thumbnail_path;
    if (safeInput) assertDemoAssetPath(safeInput, "face embedding thumbnail");
    const item: CreatorFaceEmbedding = {
      id,
      creatorId: params.creatorId,
      embedding: JSON.stringify(
        Array.from({ length: 8 }, (_value, index) =>
          Number((seed + index / 100).toFixed(4))
        )
      ),
      sourceType: params.sourceType,
      sourceVideoId: params.sourceVideoId ?? null,
      sourceTimestampSeconds: params.sourceTimestampSeconds ?? null,
      detScore: 0.99,
      isPrimary: params.isPrimary ?? existing.length === 0,
      estimatedAge: null,
      estimatedGender: null,
      thumbnailPath: safeInput ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    demoRepository.putResource(KINDS.embedding, id, item);
    return item;
  }

  async getCreatorEmbeddings(
    creatorId: number
  ): Promise<CreatorFaceEmbedding[]> {
    this.ensureSeeded();
    return (
      demoRepository.listResources(KINDS.embedding) as CreatorFaceEmbedding[]
    )
      .filter((item) => item.creatorId === creatorId)
      .map(cloneDate)
      .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
  }

  async setPrimaryEmbedding(
    creatorId: number,
    embeddingId: number
  ): Promise<void> {
    const items = await this.getCreatorEmbeddings(creatorId);
    if (!items.some((item) => item.id === embeddingId))
      throw new NotFoundError(
        `Face embedding not found with id: ${embeddingId}`
      );
    for (const item of items) {
      demoRepository.putResource(KINDS.embedding, item.id, {
        ...item,
        isPrimary: item.id === embeddingId,
        updatedAt: new Date(),
      });
    }
  }

  async deleteCreatorEmbedding(embeddingId: number): Promise<void> {
    this.ensureSeeded();
    demoRepository.deleteResource(KINDS.embedding, embeddingId);
  }

  getEmbeddingThumbnailPath(
    creatorId: number,
    embeddingId: number
  ): string | null {
    this.ensureSeeded();
    const item = demoRepository.getResource(
      KINDS.embedding,
      embeddingId
    ) as CreatorFaceEmbedding | null;
    if (!item || item.creatorId !== creatorId || !item.thumbnailPath)
      return null;
    return resolveDemoAssetPath(item.thumbnailPath);
  }

  async getVideoFaceDetections(videoId: number): Promise<VideoFaceDetection[]> {
    this.ensureSeeded();
    return (
      demoRepository.listResources(KINDS.detection) as VideoFaceDetection[]
    )
      .filter((item) => item.videoId === videoId)
      .map(cloneDate)
      .sort((a, b) => a.timestampSeconds - b.timestampSeconds);
  }

  async confirmFaceMatch(
    detectionId: number,
    creatorId: number
  ): Promise<void> {
    this.ensureSeeded();
    const detection = demoRepository.getResource(
      KINDS.detection,
      detectionId
    ) as VideoFaceDetection | null;
    if (!detection)
      throw new NotFoundError(`Detection ${detectionId} not found`);
    detection.matchedCreatorId = creatorId;
    detection.matchStatus = "confirmed";
    detection.updatedAt = new Date();
    demoRepository.putResource(KINDS.detection, detectionId, detection);
    getDemoSqlite().run(
      "INSERT OR IGNORE INTO demo_video_creators (video_id,creator_id) VALUES (?,?)",
      [detection.videoId, creatorId]
    );
  }

  async rejectFaceMatch(detectionId: number): Promise<void> {
    this.ensureSeeded();
    const detection = demoRepository.getResource(
      KINDS.detection,
      detectionId
    ) as VideoFaceDetection | null;
    if (!detection)
      throw new NotFoundError(`Detection ${detectionId} not found`);
    detection.matchedCreatorId = null;
    detection.matchConfidence = null;
    detection.matchStatus = "rejected";
    detection.updatedAt = new Date();
    demoRepository.putResource(KINDS.detection, detectionId, detection);
  }

  async findSimilarCreators(
    embedding: number[],
    limit = 10,
    threshold = 0.65
  ): Promise<SimilarityMatch[]> {
    this.ensureSeeded();
    const matches: SimilarityMatch[] = [];
    for (const item of demoRepository.listResources(
      KINDS.embedding
    ) as CreatorFaceEmbedding[]) {
      const similarity = cosine(embedding, vector(item.embedding));
      if (similarity < threshold) continue;
      const creator = demoRepository.getCreatorById(item.creatorId);
      matches.push({
        creator_id: item.creatorId,
        creator_name: creator.name,
        similarity,
        reference_embedding_id: item.id,
        reference_source_type: item.sourceType,
      });
    }
    return matches.sort((a, b) => b.similarity - a.similarity).slice(0, limit);
  }

  async autoMatchVideoFaces(
    videoId: number,
    rawDetections: RawFaceDetection[],
    similarityThreshold = 0.65
  ): Promise<void> {
    for (const raw of rawDetections) {
      const match = (
        await this.findSimilarCreators(raw.embedding, 1, similarityThreshold)
      )[0];
      if (!match) continue;
      const id = nextId(KINDS.detection);
      const item: VideoFaceDetection = {
        id,
        videoId,
        embedding: JSON.stringify(raw.embedding),
        timestampSeconds: raw.timestampSeconds,
        frameIndex: raw.frameIndex,
        bboxX1: raw.bbox[0],
        bboxY1: raw.bbox[1],
        bboxX2: raw.bbox[2],
        bboxY2: raw.bbox[3],
        detScore: raw.detScore,
        matchedCreatorId: match.creator_id,
        matchConfidence: match.similarity,
        matchStatus: "pending",
        estimatedAge: raw.estimatedAge ?? null,
        estimatedGender: raw.estimatedGender ?? null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      demoRepository.putResource(KINDS.detection, id, item);
    }
  }

  async processVideo(videoId: number): Promise<void> {
    await this.processFacesOnly(videoId);
  }

  async processFacesOnly(videoId: number): Promise<void> {
    demoRepository.getVideoById(videoId);
    const id = nextId(KINDS.job);
    const job: FaceExtractionJob = {
      id,
      videoId,
      status: "completed",
      totalFrames: 1,
      processedFrames: 1,
      facesDetected: (await this.getVideoFaceDetections(videoId)).length,
      errorMessage: null,
      retryCount: 0,
      startedAt: new Date(),
      completedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    demoRepository.putResource(KINDS.job, videoId, job);
  }

  async getFaceExtractionJob(videoId: number): Promise<FaceExtractionJob> {
    const job = demoRepository.getResource(
      KINDS.job,
      videoId
    ) as FaceExtractionJob | null;
    if (!job)
      throw new NotFoundError(
        `Face extraction job not found for video: ${videoId}`
      );
    return cloneDate(job);
  }

  async clearQueue(): Promise<void> {
    for (const job of demoRepository.listResources(
      KINDS.job
    ) as FaceExtractionJob[]) {
      if (job.status === "pending" || job.status === "processing") {
        demoRepository.putResource(KINDS.job, job.videoId, {
          ...job,
          status: "skipped",
          completedAt: new Date(),
          updatedAt: new Date(),
        });
      }
    }
  }

  async findVideosWithCreator(
    creatorId: number,
    minConfidence = 0.65
  ): Promise<
    Array<{ videoId: number; detectionCount: number; avgConfidence: number }>
  > {
    this.ensureSeeded();
    const grouped = new Map<number, number[]>();
    for (const item of demoRepository.listResources(
      KINDS.detection
    ) as VideoFaceDetection[]) {
      if (
        item.matchedCreatorId !== creatorId ||
        !["pending", "confirmed"].includes(item.matchStatus) ||
        (item.matchConfidence ?? 0) < minConfidence
      )
        continue;
      grouped.set(item.videoId, [
        ...(grouped.get(item.videoId) ?? []),
        item.matchConfidence ?? 0,
      ]);
    }
    return [...grouped].map(([videoId, values]) => ({
      videoId,
      detectionCount: values.length,
      avgConfidence:
        values.reduce((sum, value) => sum + value, 0) / values.length,
    }));
  }

  async getFaceImage(detectionId: number): Promise<FaceImage> {
    this.ensureSeeded();
    const existing = demoRepository.getResource(
      KINDS.image,
      detectionId
    ) as FaceImage | null;
    if (existing) return cloneDate(existing);
    const detection = demoRepository.getResource(
      KINDS.detection,
      detectionId
    ) as VideoFaceDetection | null;
    if (!detection) throw new NotFoundError("Face detection not found");
    const video = demoRepository.getVideoById(detection.videoId);
    const path = video.thumbnail?.file_path;
    if (!path) throw new NotFoundError("Face image not found");
    assertDemoAssetPath(path, "face image");
    const item: FaceImage = {
      id: detectionId,
      detectionId,
      filePath: resolveDemoAssetPath(path),
      fileSizeBytes: null,
      width: video.thumbnail.width ?? 320,
      height: video.thumbnail.height ?? 180,
      generatedAt: new Date(),
    };
    demoRepository.putResource(KINDS.image, detectionId, item);
    return item;
  }

  async deleteFaceImageByDetection(detectionId: number): Promise<void> {
    demoRepository.deleteResource(KINDS.image, detectionId);
  }
}

export const faceRecognitionDemoService = new FaceRecognitionDemoService();
