/**
 * Face Recognition Client
 * HTTP client for communicating with the Python face detection service
 */

import { logger } from "@/utils/logger";
import type {
  DetectFacesRequest,
  DetectFacesResponse,
  HealthCheckResponse,
} from "./face-recognition.types";
import { env } from "@/config/env";

export class FaceRecognitionClient {
  private baseUrl: string;
  private timeout: number;

  constructor(baseUrl: string, timeout: number = 30000) {
    this.baseUrl = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
    this.timeout = timeout;
  }

  /**
   * Check if the Python face service is healthy and ready
   */
  async healthCheck(): Promise<HealthCheckResponse> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      console.log(`${this.baseUrl}/health`);

      const response = await fetch(`${this.baseUrl}/health`, {
        method: "GET",
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        logger.warn(
          { status: response.status },
          "Face service health check failed",
        );
        return {
          status: "unhealthy",
        };
      }

      const data = await response.json();
      return data as HealthCheckResponse;
    } catch (error) {
      logger.error({ error }, "Face service health check error");
      return {
        status: "unhealthy",
      };
    }
  }

  /**
   * Detect faces in a base64-encoded image
   * @param request Detection request with base64 image
   * @returns Detected faces with embeddings
   */
  async detectFaces(request: DetectFacesRequest): Promise<DetectFacesResponse> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      const response = await fetch(`${this.baseUrl}/detect`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Face detection failed: ${response.status} ${errorText}`,
        );
      }

      const data = await response.json();
      return data as DetectFacesResponse;
    } catch (error) {
      if (error instanceof Error) {
        if (error.name === "AbortError") {
          throw new Error(`Face detection timeout after ${this.timeout}ms`);
        }
        throw error;
      }
      throw new Error("Face detection failed with unknown error");
    }
  }

  /**
   * Detect faces in an image file using multipart upload
   * @param imagePath Path to image file
   * @returns Detected faces with embeddings
   */
  async detectFacesFromFile(imagePath: string): Promise<DetectFacesResponse> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      // Read file and create form data
      const file = Bun.file(imagePath);
      const buffer = await file.arrayBuffer();
      const filename = imagePath.split("/").pop() || "image.jpg";

      // Determine MIME type from extension
      const ext = filename.split(".").pop()?.toLowerCase();
      const mimeType =
        ext === "png"
          ? "image/png"
          : ext === "webp"
            ? "image/webp"
            : "image/jpeg";

      const formData = new FormData();
      formData.append("file", new Blob([buffer], { type: mimeType }), filename);

      const response = await fetch(`${this.baseUrl}/detect`, {
        method: "POST",
        body: formData,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Face detection failed: ${response.status} ${errorText}`,
        );
      }

      const data = await response.json();
      return data as DetectFacesResponse;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Face detection timeout after ${this.timeout}ms`);
      }
      logger.error({ error, imagePath }, "Failed to detect faces from file");
      throw error;
    }
  }

  /**
   * Check if the face service is available and ready to process requests
   */
  async isAvailable(): Promise<boolean> {
    const health = await this.healthCheck();
    return health.status === "healthy";
  }

  /**
   * Wait for the face service to become available (with timeout)
   * @param maxWaitMs Maximum wait time in milliseconds
   * @param checkIntervalMs Interval between health checks
   * @returns True if service became available, false if timeout
   */
  async waitForAvailability(
    maxWaitMs: number = 60000,
    checkIntervalMs: number = 2000,
  ): Promise<boolean> {
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      if (await this.isAvailable()) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, checkIntervalMs));
    }

    return false;
  }
}

/**
 * Singleton instance of the face recognition client
 * Configured from environment variables
 */
let clientInstance: FaceRecognitionClient | null = null;

export function getFaceRecognitionClient(): FaceRecognitionClient {
  if (!clientInstance) {
    // Will be configured from env in next phase
    const baseUrl = env.FACE_SERVICE_URL;
    const timeout = 30000; // 30 seconds
    clientInstance = new FaceRecognitionClient(baseUrl, timeout);
  }
  return clientInstance;
}

/**
 * For testing - reset the singleton instance
 */
export function resetFaceRecognitionClient(): void {
  clientInstance = null;
}
