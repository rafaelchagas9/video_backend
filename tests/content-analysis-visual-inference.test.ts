import { afterEach, describe, expect, it, mock } from "bun:test";
import {
  HttpVisualInferenceAdapter,
  InMemoryVisualInferenceAdapter,
  VisionInferenceHttpError,
  visionBatchResultSchema,
  type VisionBatch,
} from "@/modules/content-analysis";

const originalFetch = globalThis.fetch;
const originalClearTimeout = globalThis.clearTimeout;

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.clearTimeout = originalClearTimeout;
});

function batch(): VisionBatch {
  return {
    capabilities: ["faces"],
    items: [
      {
        id: "frame-7",
        timestampSeconds: 12.5,
        image: new Blob(["image"], { type: "image/jpeg" }),
      },
    ],
  };
}

function twoItemBatch(): VisionBatch {
  const first = batch();
  return {
    ...first,
    items: [
      ...first.items,
      {
        id: "frame-8",
        timestampSeconds: 20,
        image: new Blob(["second-image"], { type: "image/jpeg" }),
      },
    ],
  };
}

const validResponse = {
  version: "1" as const,
  items: [
    {
      id: "frame-7",
      timestamp_seconds: 12.5,
      width: 640,
      height: 480,
      outcomes: [
        {
          capability: "faces",
          status: "ok" as const,
          findings: [
            {
              capability: "faces",
              label: "face",
              score: 0.98,
              box: {
                space: "normalized" as const,
                x1: 0.1,
                y1: 0.2,
                x2: 0.5,
                y2: 0.8,
              },
              embedding: Array.from({ length: 512 }, () => 0.01),
            },
          ],
        },
      ],
    },
  ],
};

describe("VisualInferencePort adapters", () => {
  it("sends an authenticated versioned multipart batch without exposing transport to callers", async () => {
    globalThis.fetch = mock(
      async (input: string | URL | Request, init?: RequestInit) => {
        expect(String(input)).toBe("http://vision.test/v1/analyze");
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer internal-secret"
        );
        expect(init?.body).toBeInstanceOf(FormData);
        const form = init?.body as FormData;
        expect(JSON.parse(String(form.get("manifest")))).toEqual({
          version: "1",
          capabilities: ["faces"],
          items: [
            {
              id: "frame-7",
              timestamp_seconds: 12.5,
              file_field: "image_0",
            },
          ],
        });
        expect(form.get("image_0")).toBeInstanceOf(Blob);
        return Response.json(validResponse);
      }
    ) as unknown as typeof fetch;

    const adapter = new HttpVisualInferenceAdapter({
      baseUrl: "http://vision.test/",
      internalSecret: "internal-secret",
      timeoutMs: 100,
    });

    await expect(
      adapter.analyzeBatch(batch(), new AbortController().signal)
    ).resolves.toEqual({
      version: "1",
      items: [
        {
          id: "frame-7",
          timestampSeconds: 12.5,
          width: 640,
          height: 480,
          outcomes: validResponse.items[0]!.outcomes,
        },
      ],
    });
  });

  it("normalizes Python null embeddings out of nudity findings", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({
        version: "1",
        items: [
          {
            id: "frame-7",
            timestamp_seconds: 12.5,
            width: 640,
            height: 480,
            outcomes: [
              {
                capability: "nudity",
                status: "ok",
                findings: [
                  {
                    capability: "nudity",
                    label: "FEMALE_BREAST_EXPOSED",
                    score: 0.82,
                    box: {
                      space: "normalized",
                      x1: 0.1,
                      y1: 0.2,
                      x2: 0.3,
                      y2: 0.4,
                    },
                    embedding: null,
                  },
                ],
              },
            ],
          },
        ],
      })
    ) as unknown as typeof fetch;
    const adapter = new HttpVisualInferenceAdapter({
      baseUrl: "http://vision.test",
    });
    const nudityBatch: VisionBatch = {
      capabilities: ["nudity"],
      items: batch().items,
    };

    const result = await adapter.analyzeBatch(
      nudityBatch,
      new AbortController().signal
    );

    expect(result.items[0]?.outcomes[0]).toMatchObject({
      capability: "nudity",
      status: "ok",
    });
    expect(
      result.items[0]?.outcomes[0]?.status === "ok"
        ? result.items[0].outcomes[0].findings[0]?.embedding
        : "unexpected-error"
    ).toBeUndefined();
  });

  it("rejects a response missing a requested item id", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({ ...validResponse, items: [] })
    ) as unknown as typeof fetch;
    const adapter = new HttpVisualInferenceAdapter({
      baseUrl: "http://vision.test",
    });

    await expect(
      adapter.analyzeBatch(batch(), new AbortController().signal)
    ).rejects.toThrow("did not echo the requested items");
  });

  it("rejects a response with an extra item id", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({
        ...validResponse,
        items: [
          ...validResponse.items,
          { ...validResponse.items[0], id: "unexpected-frame" },
        ],
      })
    ) as unknown as typeof fetch;
    const adapter = new HttpVisualInferenceAdapter({
      baseUrl: "http://vision.test",
    });

    await expect(
      adapter.analyzeBatch(batch(), new AbortController().signal)
    ).rejects.toThrow("did not echo the requested items");
  });

  it("rejects a response with a duplicate item id", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({
        ...validResponse,
        items: [validResponse.items[0], validResponse.items[0]],
      })
    ) as unknown as typeof fetch;
    const adapter = new HttpVisualInferenceAdapter({
      baseUrl: "http://vision.test",
    });

    await expect(
      adapter.analyzeBatch(twoItemBatch(), new AbortController().signal)
    ).rejects.toThrow("did not echo the requested items");
  });

  it("rejects a response that changes an echoed timestamp", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({
        ...validResponse,
        items: [{ ...validResponse.items[0], timestamp_seconds: 99 }],
      })
    ) as unknown as typeof fetch;
    const adapter = new HttpVisualInferenceAdapter({
      baseUrl: "http://vision.test",
    });

    await expect(
      adapter.analyzeBatch(batch(), new AbortController().signal)
    ).rejects.toThrow("did not echo the requested items");
  });

  it("rejects capability outcomes or findings not requested by the caller", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({
        ...validResponse,
        items: [
          {
            ...validResponse.items[0],
            outcomes: [
              {
                capability: "faces",
                status: "ok",
                findings: [
                  {
                    ...validResponse.items[0]!.outcomes[0]!.findings[0],
                    capability: "secondary",
                  },
                ],
              },
            ],
          },
        ],
      })
    ) as unknown as typeof fetch;
    const adapter = new HttpVisualInferenceAdapter({
      baseUrl: "http://vision.test",
    });

    await expect(
      adapter.analyzeBatch(batch(), new AbortController().signal)
    ).rejects.toThrow("wrong capability");
  });

  it("maps capability limits, providers, and pixel bounds", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({
        version: "1",
        capabilities: [
          {
            name: "faces",
            ready: true,
            state: "ready",
            providers: ["MIGraphXExecutionProvider", "CPUExecutionProvider"],
            model_revision: "buffalo_l@1",
            taxonomy_revision: "faces@1",
            max_batch_items: 8,
            max_batch_bytes: 8_000_000,
            max_image_bytes: 2_000_000,
            max_image_pixels: 16_000_000,
          },
        ],
      })
    ) as unknown as typeof fetch;
    const adapter = new HttpVisualInferenceAdapter({
      baseUrl: "http://vision.test",
    });

    await expect(adapter.capabilities()).resolves.toMatchObject({
      capabilities: [
        {
          name: "faces",
          providers: ["MIGraphXExecutionProvider", "CPUExecutionProvider"],
          maxImagePixels: 16_000_000,
        },
      ],
    });
  });

  it("validates normalized geometry, scores, and 512-position face embeddings", () => {
    expect(
      visionBatchResultSchema.safeParse({
        version: "1",
        items: [
          {
            id: "frame-7",
            timestampSeconds: 12.5,
            width: 640,
            height: 480,
            outcomes: [
              {
                capability: "faces",
                status: "ok",
                findings: [
                  {
                    ...validResponse.items[0]!.outcomes[0]!.findings[0],
                    score: 2,
                    embedding: [0.1],
                  },
                ],
              },
            ],
          },
        ],
      }).success
    ).toBe(false);
  });

  it("accepts only the selected nudity taxonomy and never biometric embeddings", () => {
    const nudityFinding = {
      capability: "nudity",
      label: "FEMALE_BREAST_EXPOSED",
      score: 0.82,
      box: {
        space: "normalized" as const,
        x1: 0.1,
        y1: 0.2,
        x2: 0.3,
        y2: 0.4,
      },
    };
    const result = (finding: Record<string, unknown>) => ({
      version: "1",
      items: [
        {
          id: "frame-7",
          timestampSeconds: 12.5,
          width: 640,
          height: 480,
          outcomes: [
            {
              capability: "nudity",
              status: "ok",
              findings: [finding],
            },
          ],
        },
      ],
    });

    expect(
      visionBatchResultSchema.safeParse(result(nudityFinding)).success
    ).toBe(true);
    expect(
      visionBatchResultSchema.safeParse(
        result({ ...nudityFinding, label: "FACE_FEMALE" })
      ).success
    ).toBe(false);
    expect(
      visionBatchResultSchema.safeParse(
        result({
          ...nudityFinding,
          embedding:
            validResponse.items[0]!.outcomes[0]!.findings[0]!.embedding,
        })
      ).success
    ).toBe(false);
  });

  it("provides a deterministic in-memory adapter through the same interface", async () => {
    const adapter = new InMemoryVisualInferenceAdapter({
      findingsByItemId: {
        "frame-7": validResponse.items[0]!.outcomes[0]!.findings,
      },
      dimensionsByItemId: { "frame-7": { width: 640, height: 480 } },
    });

    const result = await adapter.analyzeBatch(
      batch(),
      new AbortController().signal
    );

    expect(result.items[0]).toMatchObject({
      id: "frame-7",
      timestampSeconds: 12.5,
      width: 640,
      height: 480,
      outcomes: validResponse.items[0]!.outcomes,
    });
    expect(adapter.requests).toHaveLength(1);
  });

  it("honors cancellation before any in-memory inference", async () => {
    const controller = new AbortController();
    controller.abort();
    const adapter = new InMemoryVisualInferenceAdapter();

    await expect(
      adapter.analyzeBatch(batch(), controller.signal)
    ).rejects.toThrow("aborted");
    expect(adapter.requests).toHaveLength(0);
  });

  it("classifies network failures as retryable transport errors", async () => {
    globalThis.fetch = mock(async () => {
      throw new TypeError("connection refused");
    }) as unknown as typeof fetch;
    const adapter = new HttpVisualInferenceAdapter({
      baseUrl: "http://vision.test",
    });

    const failure = adapter.analyzeBatch(batch(), new AbortController().signal);
    await expect(failure).rejects.toBeInstanceOf(VisionInferenceHttpError);
    await failure.catch((error: VisionInferenceHttpError) => {
      expect(error.code).toBe("VISION_UNAVAILABLE");
      expect(error.retryable).toBe(true);
    });
  });

  it("classifies an HTTP 429 response as retryable and preserves its code", async () => {
    globalThis.fetch = mock(async () =>
      Response.json(
        { detail: { code: "OVERLOADED", message: "capacity exhausted" } },
        { status: 429 }
      )
    ) as unknown as typeof fetch;
    const adapter = new HttpVisualInferenceAdapter({
      baseUrl: "http://vision.test",
    });

    const error = await adapter
      .analyzeBatch(batch(), new AbortController().signal)
      .catch((failure: VisionInferenceHttpError) => failure);

    expect(error).toMatchObject({
      status: 429,
      code: "OVERLOADED",
      retryable: true,
    });
  });

  it("classifies an HTTP 5xx response as retryable and preserves its code", async () => {
    globalThis.fetch = mock(async () =>
      Response.json(
        { detail: { code: "VISION_NOT_READY", message: "model unavailable" } },
        { status: 503 }
      )
    ) as unknown as typeof fetch;
    const adapter = new HttpVisualInferenceAdapter({
      baseUrl: "http://vision.test",
    });

    const error = await adapter
      .analyzeBatch(batch(), new AbortController().signal)
      .catch((failure: VisionInferenceHttpError) => failure);

    expect(error).toMatchObject({
      status: 503,
      code: "VISION_NOT_READY",
      retryable: true,
    });
  });

  it("preserves an external abort reason instead of classifying it as transport failure", async () => {
    const clearTimeoutMock = mock((timer: ReturnType<typeof setTimeout>) =>
      originalClearTimeout(timer)
    );
    globalThis.clearTimeout =
      clearTimeoutMock as unknown as typeof clearTimeout;
    globalThis.fetch = mock(
      async (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          const rejectAsFetchWould = () =>
            reject(new DOMException("The operation was aborted", "AbortError"));
          if (signal?.aborted) return rejectAsFetchWould();
          signal?.addEventListener("abort", rejectAsFetchWould, { once: true });
        })
    ) as unknown as typeof fetch;
    const adapter = new HttpVisualInferenceAdapter({
      baseUrl: "http://vision.test",
      timeoutMs: 10_000,
    });
    const controller = new AbortController();
    const reason = new Error("caller cancelled analysis");

    const request = adapter.analyzeBatch(batch(), controller.signal);
    controller.abort(reason);

    await expect(request).rejects.toBe(reason);
    expect(clearTimeoutMock).toHaveBeenCalledTimes(1);
  });

  it("clears its request timer after success and transport failures", async () => {
    const clearTimeoutMock = mock((timer: ReturnType<typeof setTimeout>) =>
      originalClearTimeout(timer)
    );
    globalThis.clearTimeout =
      clearTimeoutMock as unknown as typeof clearTimeout;
    const responses: Array<"success" | "http" | "network"> = [
      "success",
      "http",
      "network",
    ];
    globalThis.fetch = mock(async () => {
      const outcome = responses.shift();
      if (outcome === "success") return Response.json(validResponse);
      if (outcome === "http") return new Response(null, { status: 503 });
      throw new TypeError("connection refused");
    }) as unknown as typeof fetch;
    const adapter = new HttpVisualInferenceAdapter({
      baseUrl: "http://vision.test",
    });

    await adapter.analyzeBatch(batch(), new AbortController().signal);
    await adapter
      .analyzeBatch(batch(), new AbortController().signal)
      .catch(() => undefined);
    await adapter
      .analyzeBatch(batch(), new AbortController().signal)
      .catch(() => undefined);

    expect(clearTimeoutMock).toHaveBeenCalledTimes(3);
  });
});
