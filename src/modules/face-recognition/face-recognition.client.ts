/**
 * Face recognition compatibility facade.
 *
 * Face callers keep their established pixel-based contract while transport,
 * batching, and capability discovery are owned by VisualInferencePort.
 */

import { env } from "@/config/env";
import {
  HttpVisualInferenceAdapter,
  type VisualInferencePort,
  type VisionFinding,
} from "@/modules/content-analysis";
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
const SINGLE_IMAGE_ID = "face-0";

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

  async healthCheck(): Promise<HealthCheckResponse> {
    if (env.DEMO_MODE) return faceRecognitionDemoService.healthCheck();

    try {
      const manifest = await this.inference.capabilities();
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
      const file = Bun.file(imagePath);
      const buffer = await file.arrayBuffer();
      const extension = imagePath.split(".").pop()?.toLowerCase();
      const mimeType =
        extension === "png"
          ? "image/png"
          : extension === "webp"
            ? "image/webp"
            : "image/jpeg";
      return await this.detectImage(
        new Blob([buffer], { type: mimeType }),
        signal
      );
    } catch (error) {
      logger.error({ error }, "Failed to analyze image for faces");
      throw error;
    }
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
    const startedAt = performance.now();
    const result = await this.inference.analyzeBatch(
      {
        capabilities: [FACE_CAPABILITY],
        items: [{ id: SINGLE_IMAGE_ID, timestampSeconds: 0, image }],
      },
      signal ?? new AbortController().signal
    );
    const item = result.items[0];
    const outcome = item?.outcomes[0];

    if (!item || !outcome || outcome.capability !== FACE_CAPABILITY) {
      throw new Error("Vision service omitted the face analysis result");
    }
    if (outcome.status === "error") {
      throw new Error(
        `Face analysis failed (${outcome.error.code}): ${outcome.error.message}`
      );
    }
    if (item.width === undefined || item.height === undefined) {
      throw new Error("Vision service omitted face image dimensions");
    }

    return {
      faces: outcome.findings.map((finding) =>
        faceFindingToLegacyResult(finding, item.width!, item.height!)
      ),
      image_width: item.width,
      image_height: item.height,
      processing_time_ms: Math.max(0, performance.now() - startedAt),
    };
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

export function resetFaceRecognitionClient(): void {
  clientInstance = null;
}
