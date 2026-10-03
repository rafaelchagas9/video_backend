import { z } from "zod";
import { env } from "@/config/env";
import { AppError } from "@/utils/errors";

/** Vision-service SigLIP2 endpoints (`/v1/embeddings/*`). */

const pagesResponseSchema = z.object({
  model_revision: z.string(),
  dimension: z.number().int().positive(),
  dtype: z.literal("float16"),
  pages: z.array(
    z.object({ id: z.string(), count: z.number().int(), embeddings: z.string() })
  ),
  errors: z.array(z.object({ id: z.string(), code: z.string(), message: z.string() })),
});

const textResponseSchema = z.object({
  model_revision: z.string(),
  dimension: z.number().int().positive(),
  embeddings: z.array(z.array(z.number())),
});

const capabilitiesSchema = z.object({
  capabilities: z.array(
    z.object({ name: z.string(), ready: z.boolean(), state: z.string(), model_revision: z.string().nullable() })
  ),
});

export interface StoryboardPageInput {
  id: string;
  image: Uint8Array;
  fileName: string;
  tileWidth: number;
  tileHeight: number;
  /** 0 lets the service derive it from the image width (legacy single sheets). */
  columns: number;
  count: number;
}

export interface PageEmbeddings {
  modelRevision: string;
  dimension: number;
  /** Page id → row-major fp16 vectors (count × dimension). */
  pages: Map<string, Uint16Array>;
  errors: { id: string; code: string }[];
}

export interface ClipStatus {
  available: boolean;
  ready: boolean;
  state: string;
  modelRevision: string | null;
}

export class VisualSearchUnavailableError extends AppError {
  constructor(message: string, readonly code = "VISUAL_SEARCH_UNAVAILABLE") {
    super(503, message);
  }
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return env.VISION_SERVICE_SECRET
    ? { ...extra, Authorization: `Bearer ${env.VISION_SERVICE_SECRET}` }
    : extra;
}

async function failure(response: Response): Promise<VisualSearchUnavailableError> {
  let code = "VISION_REQUEST_FAILED";
  try {
    const body = (await response.json()) as { detail?: { code?: string } };
    code = body.detail?.code ?? code;
  } catch {
    // keep the generic code
  }
  if (code === "CAPABILITY_NOT_READY")
    return new VisualSearchUnavailableError("The visual search model is still loading", code);
  return new VisualSearchUnavailableError(`Vision service rejected the request (${code})`, code);
}

export const visualSearchClient = {
  async status(): Promise<ClipStatus> {
    try {
      const response = await fetch(`${env.VISION_SERVICE_URL}/v1/capabilities`, {
        headers: headers(),
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) throw new Error(String(response.status));
      const clip = capabilitiesSchema
        .parse(await response.json())
        .capabilities.find((capability) => capability.name === "clip");
      if (!clip) return { available: false, ready: false, state: "disabled", modelRevision: null };
      return {
        available: true,
        ready: clip.ready,
        state: clip.state,
        modelRevision: clip.model_revision,
      };
    } catch {
      return { available: false, ready: false, state: "unreachable", modelRevision: null };
    }
  },

  async embedText(texts: string[]): Promise<{ modelRevision: string; vectors: Float32Array[] }> {
    let response: Response;
    try {
      response = await fetch(`${env.VISION_SERVICE_URL}/v1/embeddings/text`, {
        method: "POST",
        headers: headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({ texts }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new VisualSearchUnavailableError("The vision service is unreachable");
    }
    if (!response.ok) throw await failure(response);
    const body = textResponseSchema.parse(await response.json());
    return {
      modelRevision: body.model_revision,
      vectors: body.embeddings.map((row) => Float32Array.from(row)),
    };
  },

  async embedPages(
    pages: StoryboardPageInput[],
    signal?: AbortSignal
  ): Promise<PageEmbeddings> {
    const form = new FormData();
    form.append(
      "manifest",
      JSON.stringify({
        version: "1",
        pages: pages.map((page, index) => ({
          id: page.id,
          file_field: `page_${index}`,
          tile_width: page.tileWidth,
          tile_height: page.tileHeight,
          columns: page.columns,
          count: page.count,
        })),
      })
    );
    pages.forEach((page, index) =>
      form.append(`page_${index}`, new Blob([page.image]), page.fileName)
    );
    let response: Response;
    try {
      response = await fetch(`${env.VISION_SERVICE_URL}/v1/embeddings/pages`, {
        method: "POST",
        headers: headers(),
        body: form,
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(600_000)]) : AbortSignal.timeout(600_000),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new VisualSearchUnavailableError("The vision service is unreachable");
    }
    if (!response.ok) throw await failure(response);
    const body = pagesResponseSchema.parse(await response.json());
    const result = new Map<string, Uint16Array>();
    for (const page of body.pages) {
      const bytes = Buffer.from(page.embeddings, "base64");
      if (bytes.byteLength !== page.count * body.dimension * 2)
        throw new VisualSearchUnavailableError("Vision service returned a malformed embedding");
      result.set(
        page.id,
        new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2).slice()
      );
    }
    return {
      modelRevision: body.model_revision,
      dimension: body.dimension,
      pages: result,
      errors: body.errors.map(({ id, code }) => ({ id, code })),
    };
  },
};
