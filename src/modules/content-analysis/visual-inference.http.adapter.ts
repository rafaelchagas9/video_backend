import { z } from "zod";
import {
  VISION_CONTRACT_VERSION,
  visionBatchResultSchema,
  visionBatchSchema,
  visionCapabilitiesSchema,
  validateVisionBatchResultForRequest,
} from "./visual-inference.schemas";
import type {
  VisualInferencePort,
  VisionBatch,
  VisionBatchResult,
  VisionCapabilities,
} from "./visual-inference.types";

const wireCapabilitySchema = z.object({
  name: z.string().trim().min(1),
  ready: z.boolean(),
  state: z.string().trim().min(1),
  providers: z.array(z.string()),
  model_revision: z.string().nullable(),
  taxonomy_revision: z.string().nullable(),
  max_batch_items: z.number().int().positive(),
  max_batch_bytes: z.number().int().positive(),
  max_image_bytes: z.number().int().positive(),
  max_image_pixels: z.number().int().positive(),
});

const wireCapabilitiesSchema = z.object({
  version: z.literal(VISION_CONTRACT_VERSION),
  capabilities: z.array(wireCapabilitySchema),
});

const wireFindingSchema = z.object({
  capability: z.string(),
  label: z.string(),
  score: z.number(),
  box: z
    .object({
      space: z.literal("normalized"),
      x1: z.number(),
      y1: z.number(),
      x2: z.number(),
      y2: z.number(),
    })
    .optional(),
  embedding: z.array(z.number()).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const wireBatchResultSchema = z.object({
  version: z.literal(VISION_CONTRACT_VERSION),
  items: z.array(
    z.object({
      id: z.string(),
      timestamp_seconds: z.number(),
      width: z.number().int().positive().nullable(),
      height: z.number().int().positive().nullable(),
      outcomes: z.array(
        z.discriminatedUnion("status", [
          z.object({
            capability: z.string(),
            status: z.literal("ok"),
            findings: z.array(wireFindingSchema),
          }),
          z.object({
            capability: z.string(),
            status: z.literal("error"),
            error: z.object({ code: z.string(), message: z.string() }),
          }),
        ])
      ),
    })
  ),
});

const wireErrorSchema = z.object({
  detail: z
    .object({
      code: z.string().optional(),
      message: z.string().optional(),
    })
    .optional(),
});

export interface HttpVisualInferenceAdapterOptions {
  baseUrl: string;
  timeoutMs?: number;
  internalSecret?: string;
  fetch?: typeof fetch;
}

export class VisionInferenceHttpError extends Error {
  readonly retryable: boolean;

  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    retryable?: boolean
  ) {
    super(message);
    this.retryable =
      retryable ?? (status === 0 || status === 429 || status >= 500);
    Object.setPrototypeOf(this, VisionInferenceHttpError.prototype);
  }
}

export class HttpVisualInferenceAdapter implements VisualInferencePort {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly internalSecret: string;
  private readonly fetchImplementation: typeof fetch;

  constructor(options: HttpVisualInferenceAdapterOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.internalSecret = options.internalSecret ?? "";
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
  }

  async capabilities(signal?: AbortSignal): Promise<VisionCapabilities> {
    const response = await this.request("/v1/capabilities", {
      method: "GET",
      signal,
    });
    const wire = wireCapabilitiesSchema.parse(await response.json());
    return visionCapabilitiesSchema.parse({
      version: wire.version,
      capabilities: wire.capabilities.map((capability) => ({
        name: capability.name,
        ready: capability.ready,
        state: capability.state,
        providers: capability.providers,
        modelRevision: capability.model_revision,
        taxonomyRevision: capability.taxonomy_revision,
        maxBatchItems: capability.max_batch_items,
        maxBatchBytes: capability.max_batch_bytes,
        maxImageBytes: capability.max_image_bytes,
        maxImagePixels: capability.max_image_pixels,
      })),
    });
  }

  async analyzeBatch(
    input: VisionBatch,
    signal: AbortSignal
  ): Promise<VisionBatchResult> {
    const batch = visionBatchSchema.parse(input);
    const form = new FormData();
    const manifest = {
      version: VISION_CONTRACT_VERSION,
      capabilities: batch.capabilities,
      items: batch.items.map((item, index) => ({
        id: item.id,
        timestamp_seconds: item.timestampSeconds,
        file_field: `image_${index}`,
      })),
    };
    form.append("manifest", JSON.stringify(manifest));
    batch.items.forEach((item, index) => {
      const extension =
        item.image.type === "image/png"
          ? "png"
          : item.image.type === "image/webp"
            ? "webp"
            : "jpg";
      form.append(`image_${index}`, item.image, `frame-${index}.${extension}`);
    });

    const response = await this.request("/v1/analyze", {
      method: "POST",
      headers: this.internalSecret
        ? { Authorization: `Bearer ${this.internalSecret}` }
        : undefined,
      body: form,
      signal,
    });
    const wire = wireBatchResultSchema.parse(await response.json());
    const result = visionBatchResultSchema.parse({
      version: wire.version,
      items: wire.items.map((item) => ({
        id: item.id,
        timestampSeconds: item.timestamp_seconds,
        width: item.width ?? undefined,
        height: item.height ?? undefined,
        outcomes: item.outcomes.map((outcome) =>
          outcome.status === "error"
            ? outcome
            : {
                ...outcome,
                findings: outcome.findings.map((finding) => ({
                  ...finding,
                  embedding: finding.embedding ?? undefined,
                })),
              }
        ),
      })),
    });
    return validateVisionBatchResultForRequest(batch, result);
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const externalSignal = init.signal;
    const abort = () => controller.abort(externalSignal?.reason);
    if (externalSignal?.aborted) abort();
    else externalSignal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImplementation(
        `${this.baseUrl}${path}`,
        {
          ...init,
          signal: controller.signal,
        }
      );
      if (response.ok) return response;

      const body = wireErrorSchema.safeParse(
        await response.json().catch(() => null)
      );
      const code = body.success
        ? (body.data.detail?.code ?? "VISION_HTTP_ERROR")
        : "VISION_HTTP_ERROR";
      const message = body.success
        ? (body.data.detail?.message ??
          `Vision request failed (${response.status})`)
        : `Vision request failed (${response.status})`;
      throw new VisionInferenceHttpError(message, response.status, code);
    } catch (error) {
      if (externalSignal?.aborted) {
        throw externalSignal.reason ?? error;
      }
      if (controller.signal.aborted && !externalSignal?.aborted) {
        throw new VisionInferenceHttpError(
          `Vision request timed out after ${this.timeoutMs}ms`,
          0,
          "VISION_TIMEOUT",
          true
        );
      }
      if (
        !externalSignal?.aborted &&
        !(error instanceof VisionInferenceHttpError)
      ) {
        throw new VisionInferenceHttpError(
          "Vision service unavailable",
          0,
          "VISION_UNAVAILABLE",
          true
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", abort);
    }
  }
}
