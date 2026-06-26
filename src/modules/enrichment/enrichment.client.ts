/**
 * Enrichment Client
 * HTTP client for the Python creator-enrichment microservice.
 */

import { env } from "@/config/env";
import { logger } from "@/utils/logger";
import type {
  EnrichRequest,
  EnrichResponse,
  EnrichmentHealthResponse,
} from "./enrichment.types";

export class EnrichmentClient {
  private baseUrl: string;
  private timeout: number;

  constructor(baseUrl: string, timeout = 60000) {
    this.baseUrl = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
    this.timeout = timeout;
  }

  async healthCheck(): Promise<EnrichmentHealthResponse> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      const response = await fetch(`${this.baseUrl}/health`, {
        method: "GET",
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        logger.warn(
          { status: response.status },
          "Enrichment service health check failed",
        );
        return { status: "unhealthy" };
      }
      return (await response.json()) as EnrichmentHealthResponse;
    } catch (error) {
      logger.error({ error }, "Enrichment service health check error");
      return { status: "unhealthy" };
    }
  }

  async isAvailable(): Promise<boolean> {
    const health = await this.healthCheck();
    return health.status === "healthy";
  }

  /** Discover candidate metadata for a creator. */
  async enrich(request: EnrichRequest): Promise<EnrichResponse> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(`${this.baseUrl}/enrich`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Enrichment request failed: ${response.status} ${errorText}`,
        );
      }

      return (await response.json()) as EnrichResponse;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Enrichment request timeout after ${this.timeout}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

let clientInstance: EnrichmentClient | null = null;

export function getEnrichmentClient(): EnrichmentClient {
  if (!clientInstance) {
    clientInstance = new EnrichmentClient(env.ENRICHMENT_SERVICE_URL);
  }
  return clientInstance;
}

export function resetEnrichmentClient(): void {
  clientInstance = null;
}
