/**
 * Face recognition compatibility facade.
 *
 * Face callers keep their established pixel-based contract while transport,
 * batching, and capability discovery are owned by VisualInferencePort.
 */

import { setTimeout as sleep } from "node:timers/promises";
import { env } from "@/config/env";
import {
  HttpVisualInferenceAdapter,
  type VisualInferencePort,
  type VisionBatchItemResult,
  type VisionCapabilityOutcome,
  type VisionFinding,
} from "@/modules/content-analysis";
import { GpuLaneUnavailableError } from "@/utils/gpu-modes";
import { logger } from "@/utils/logger";
import { normalizedFaceBoxToPixels } from "./face-recognition.coordinates";
import { faceRecognitionDemoService } from "./face-recognition.demo.service";
import { FACE_EMBEDDING_DIMENSION } from "./face-recognition.embedding";
import type {
  DetectFacesRequest,
  DetectFacesResponse,
  FaceDetectionResult,
  HealthCheckResponse,
} from "./face-recognition.types";

const FACE_CAPABILITY = "faces";

/**
 * The service admits one inference per capability with a 0.1 s queue wait, and other models
 * warm in the background after it reports ready. Batched frames back off instead of being
 * dropped (a run once lost 206 of 406 frames this way right after a vision start).
 */
const TRANSIENT_OUTCOME_CODES = new Set(["OVERLOADED", "CAPABILITY_NOT_READY"]);
const TRANSIENT_RETRY_WINDOW_MS = 120_000;

function demoDetection(): DetectFacesResponse {
  return {
    faces: [
      {
        bbox: [0.2, 0.1, 0.8, 0.9],
        det_score: 0.99,
        embedding: Array.from({ length: FACE_EMBEDDING_DIMENSION }, () => 0.01),
      },
    ],
    image_width: 640,
    image_height: 640,
    processing_time_ms: 0,
  };
}

function base64ImageToBlob(imageBase64: string): Blob {
  const buffer = Buffer.from(imageBase64, "base64");
  const bytes = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength
  ) as ArrayBuffer;
  return new Blob([bytes], { type: "image/jpeg" });
}

function faceFindingToLegacyResult(
  finding: VisionFinding,
  width: number,
  height: number
): FaceDetectionResult {
  if (finding.label !== "face" || !finding.embedding) {
    throw new Error("Vision service returned an invalid face finding");
  }

  return {
    bbox: normalizedFaceBoxToPixels(
      [finding.box.x1, finding.box.y1, finding.box.x2, finding.box.y2],
      width,
      height
    ),
    det_score: finding.score,
    embedding: finding.embedding,
  };
}

export class FaceRecognitionClient {
  private readonly inference: VisualInferencePort;

  constructor(
    baseUrl: string,
    timeout: number = 30000,
    internalSecret: string = "",
    inference?: VisualInferencePort
  ) {
    this.inference =
      inference ??
      new HttpVisualInferenceAdapter({
        baseUrl,
        timeoutMs: timeout,
        internalSecret,
      });
  }

  /** `passive` reports without starting a vision unit stopped for VAAPI work. */
  async healthCheck(
    options: { passive?: boolean } = {}
  ): Promise<HealthCheckResponse> {
    if (env.DEMO_MODE) return faceRecognitionDemoService.healthCheck();

    try {
      const manifest = await this.inference.capabilities(undefined, options);
      const faces = manifest.capabilities.find(
        (capability) => capability.name === FACE_CAPABILITY
      );
      if (!faces) return { status: "unhealthy", version: manifest.version };

      return {
        status: faces.ready ? "healthy" : "degraded",
        version: manifest.version,
        model: faces.modelRevision ?? undefined,
        onnx_providers: faces.providers,
        embedding_dimension: FACE_EMBEDDING_DIMENSION,
      };
    } catch (error) {
      if (error instanceof GpuLaneUnavailableError) return { status: "degraded" };
      logger.error({ error }, "Vision capability check failed");
      return { status: "unhealthy" };
    }
  }

  async detectFaces(
    request: DetectFacesRequest,
    signal?: AbortSignal
  ): Promise<DetectFacesResponse> {
    if (env.DEMO_MODE) return demoDetection();
    return this.detectImage(base64ImageToBlob(request.image_base64), signal);
  }

  async detectFacesFromFile(
    imagePath: string,
    signal?: AbortSignal
  ): Promise<DetectFacesResponse> {
    if (env.DEMO_MODE) return demoDetection();

    try {
      return await this.detectImage(await readImage(imagePath), signal);
    } catch (error) {
      logger.error({ error }, "Failed to analyze image for faces");
      throw error;
    }
  }

  /**
   * One vision request for several images (the service admits one inference at a time, so
   * parallel single-image calls mostly bounce as OVERLOADED). Per-image failures come back
   * as Error entries in input order.
   */
  async detectFacesFromFiles(
    imagePaths: string[],
    signal?: AbortSignal
  ): Promise<Array<DetectFacesResponse | Error>> {
    if (env.DEMO_MODE) return imagePaths.map(() => demoDetection());
    return this.detectImages(
      await Promise.all(imagePaths.map(readImage)),
      signal
    );
  }

  async isAvailable(): Promise<boolean> {
    return (await this.healthCheck()).status === "healthy";
  }

  async waitForAvailability(
    maxWaitMs: number = 60000,
    checkIntervalMs: number = 2000
  ): Promise<boolean> {
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      if (await this.isAvailable()) return true;
      await new Promise((resolve) => setTimeout(resolve, checkIntervalMs));
    }

    return false;
  }

  private async detectImage(
    image: Blob,
    signal?: AbortSignal
  ): Promise<DetectFacesResponse> {
    const [result] = await this.detectImages([image], signal);
    if (!result) throw new Error("Vision service omitted the face analysis result");
    if (result instanceof Error) throw result;
    return result;
  }

  private async detectImages(
    images: Blob[],
    signal?: AbortSignal
  ): Promise<Array<DetectFacesResponse | Error>> {
    const startedAt = performance.now();
    const deadline = Date.now() + TRANSIENT_RETRY_WINDOW_MS;
    const results: Array<DetectFacesResponse | Error | undefined> = images.map(
      () => undefined
    );
    let pending = images.map((_, index) => index);
    for (let attempt = 0; pending.length > 0; attempt++) {
      const batch = await this.inference.analyzeBatch(
        {
          capabilities: [FACE_CAPABILITY],
          items: pending.map((index) => ({
            id: `face-${index}`,
            timestampSeconds: 0,
            image: images[index]!,
          })),
        },
        signal ?? new AbortController().signal
      );
      const byId = new Map(batch.items.map((item) => [item.id, item]));
      const retry: number[] = [];
      for (const index of pending) {
        const item = byId.get(`face-${index}`);
        const outcome = item?.outcomes[0];
        if (
          outcome?.status === "error" &&
          TRANSIENT_OUTCOME_CODES.has(outcome.error.code) &&
          Date.now() < deadline
        ) {
          retry.push(index);
          continue;
        }
        results[index] = toFaceResponse(item, outcome, startedAt);
      }
      pending = retry;
      if (pending.length > 0)
        await sleep(Math.min(250 * 2 ** attempt, 2_000), undefined, signal ? { signal } : {});
    }
    return results.map(
      (result) => result ?? new Error("Vision service omitted the face analysis result")
    );
  }
}

async function readImage(imagePath: string): Promise<Blob> {
  const buffer = await Bun.file(imagePath).arrayBuffer();
  const extension = imagePath.split(".").pop()?.toLowerCase();
  const mimeType =
    extension === "png"
      ? "image/png"
      : extension === "webp"
        ? "image/webp"
        : "image/jpeg";
  return new Blob([buffer], { type: mimeType });
}

function toFaceResponse(
  item: VisionBatchItemResult | undefined,
  outcome: VisionCapabilityOutcome | undefined,
  startedAt: number
): DetectFacesResponse | Error {
  if (!item || !outcome || outcome.capability !== FACE_CAPABILITY) {
    return new Error("Vision service omitted the face analysis result");
  }
  if (outcome.status === "error") {
    return new Error(
      `Face analysis failed (${outcome.error.code}): ${outcome.error.message}`
    );
  }
  if (item.width === undefined || item.height === undefined) {
    return new Error("Vision service omitted face image dimensions");
  }
  const { width, height } = item;
  try {
    return {
      faces: outcome.findings.map((finding) =>
        faceFindingToLegacyResult(finding, width, height)
      ),
      image_width: width,
      image_height: height,
      processing_time_ms: Math.max(0, performance.now() - startedAt),
    };
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

let clientInstance: FaceRecognitionClient | null = null;

export function getFaceRecognitionClient(): FaceRecognitionClient {
  if (!clientInstance) {
    clientInstance = new FaceRecognitionClient(
      env.VISION_SERVICE_URL,
      30000,
      env.VISION_SERVICE_SECRET
    );
  }
  return clientInstance;
}
