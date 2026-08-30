import { afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import { fileURLToPath } from "node:url";
import type {
  VisionBatchResult,
  VisualInferencePort,
} from "@/modules/content-analysis";

process.env.POSTGRES_USER ||= "face-client-test";
process.env.POSTGRES_PASSWORD ||= "face-client-test";
process.env.SESSION_SECRET ||=
  "face-client-test-session-secret-at-least-32-characters";
process.env.DEMO_MODE = "false";

const originalFetch = globalThis.fetch;
const originalClearTimeout = globalThis.clearTimeout;

let FaceRecognitionClient: typeof import("@/modules/face-recognition/face-recognition.client").FaceRecognitionClient;

const validEmbedding = Array.from({ length: 512 }, () => 0.01);
const encodedImage = Buffer.from("synthetic-image").toString("base64");

const validVisionResponse = {
  version: "1",
  items: [
    {
      id: "face-0",
      timestamp_seconds: 0,
      width: 640,
      height: 480,
      outcomes: [
        {
          capability: "faces",
          status: "ok",
          findings: [
            {
              capability: "faces",
              label: "face",
              score: 0.98,
              box: {
                space: "normalized",
                x1: 0.1,
                y1: 0.2,
                x2: 0.5,
                y2: 0.8,
              },
              embedding: validEmbedding,
            },
          ],
        },
      ],
    },
  ],
};

const validCapabilities = {
  version: "1",
  capabilities: [
    {
      name: "faces",
      ready: true,
      state: "ready",
      providers: ["CPUExecutionProvider"],
      model_revision: "insightface-0.7.3/buffalo_l",
      taxonomy_revision: "faces-v1",
      max_batch_items: 16,
      max_batch_bytes: 33_554_432,
      max_image_bytes: 10_485_760,
      max_image_pixels: 40_000_000,
    },
  ],
};

beforeAll(async () => {
  ({ FaceRecognitionClient } =
    await import("@/modules/face-recognition/face-recognition.client"));
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.clearTimeout = originalClearTimeout;
});

describe("FaceRecognitionClient compatibility facade", () => {
  it("uses the generic batch contract and restores pixel coordinates", async () => {
    const fetchMock = mock(
      async (input: string | URL | Request, init?: RequestInit) => {
        expect(String(input)).toBe("http://vision.test/v1/analyze");
        expect(init?.method).toBe("POST");
        expect(init?.body).toBeInstanceOf(FormData);
        const form = init?.body as FormData;
        expect(JSON.parse(String(form.get("manifest")))).toEqual({
          version: "1",
          capabilities: ["faces"],
          items: [
            {
              id: "face-0",
              timestamp_seconds: 0,
              file_field: "image_0",
            },
          ],
        });
        expect(form.get("image_0")).toBeInstanceOf(Blob);
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        return Response.json(validVisionResponse);
      }
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new FaceRecognitionClient("http://vision.test", 100);
    const result = await client.detectFaces({ image_base64: encodedImage });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      faces: [
        {
          bbox: [64, 96, 320, 384],
          embedding: validEmbedding,
          det_score: 0.98,
        },
      ],
      image_width: 640,
      image_height: 480,
    });
    expect(result.processing_time_ms).toBeGreaterThanOrEqual(0);
  });

  it("passes the caller AbortSignal unchanged for base64 inference", async () => {
    const controller = new AbortController();
    const analyzeBatch = mock(
      async (
        _input: unknown,
        signal: AbortSignal
      ): Promise<VisionBatchResult> => {
        expect(signal).toBe(controller.signal);
        return {
          version: "1" as const,
          items: [
            {
              id: "face-0",
              timestampSeconds: 0,
              width: 640,
              height: 480,
              outcomes: [
                {
                  capability: "faces",
                  status: "ok" as const,
                  findings:
                    validVisionResponse.items[0]!.outcomes[0]!.findings.map(
                      (finding) => ({
                        ...finding,
                        box: {
                          ...finding.box,
                          space: "normalized" as const,
                        },
                      })
                    ),
                },
              ],
            },
          ],
        };
      }
    );
    const port = {
      capabilities: mock(async () => ({
        version: "1" as const,
        capabilities: [],
      })),
      analyzeBatch,
    } satisfies VisualInferencePort;
    const client = new FaceRecognitionClient(
      "http://unused.test",
      100,
      "",
      port
    );

    await client.detectFaces({ image_base64: encodedImage }, controller.signal);

    expect(analyzeBatch).toHaveBeenCalledTimes(1);
  });

  it("passes the caller AbortSignal unchanged for file inference", async () => {
    const controller = new AbortController();
    const analyzeBatch = mock(
      async (
        _input: unknown,
        signal: AbortSignal
      ): Promise<VisionBatchResult> => {
        expect(signal).toBe(controller.signal);
        return {
          version: "1" as const,
          items: [
            {
              id: "face-0",
              timestampSeconds: 0,
              width: 640,
              height: 480,
              outcomes: [
                {
                  capability: "faces",
                  status: "ok" as const,
                  findings: [],
                },
              ],
            },
          ],
        };
      }
    );
    const port = {
      capabilities: mock(async () => ({
        version: "1" as const,
        capabilities: [],
      })),
      analyzeBatch,
    } satisfies VisualInferencePort;
    const client = new FaceRecognitionClient(
      "http://unused.test",
      100,
      "",
      port
    );

    await client.detectFacesFromFile(
      fileURLToPath(import.meta.url),
      controller.signal
    );

    expect(analyzeBatch).toHaveBeenCalledTimes(1);
  });

  it("sends the bearer secret only to analysis, not capability discovery", async () => {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    globalThis.fetch = mock(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        requests.push({
          url,
          authorization: new Headers(init?.headers).get("authorization"),
        });
        return url.endsWith("/v1/capabilities")
          ? Response.json(validCapabilities)
          : Response.json(validVisionResponse);
      }
    ) as unknown as typeof fetch;

    const client = new FaceRecognitionClient(
      "http://vision.test",
      100,
      "internal-secret"
    );
    await expect(client.healthCheck()).resolves.toMatchObject({
      status: "healthy",
      model: "insightface-0.7.3/buffalo_l",
      embedding_dimension: 512,
    });
    await client.detectFaces({ image_base64: encodedImage });

    expect(requests).toEqual([
      {
        url: "http://vision.test/v1/capabilities",
        authorization: null,
      },
      {
        url: "http://vision.test/v1/analyze",
        authorization: "Bearer internal-secret",
      },
    ]);
  });

  it("rejects malformed dimensions, boxes, and embeddings", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({
        ...validVisionResponse,
        items: [
          {
            ...validVisionResponse.items[0],
            width: "640",
            outcomes: [
              {
                ...validVisionResponse.items[0]!.outcomes[0],
                findings: [
                  {
                    ...validVisionResponse.items[0]!.outcomes[0]!.findings[0],
                    embedding: [0.1],
                  },
                ],
              },
            ],
          },
        ],
      })
    ) as unknown as typeof fetch;

    const client = new FaceRecognitionClient("http://vision.test", 100);
    await expect(
      client.detectFaces({ image_base64: encodedImage })
    ).rejects.toThrow();
  });

  it("does not leak generic metadata into the legacy face result", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({
        ...validVisionResponse,
        items: [
          {
            ...validVisionResponse.items[0],
            outcomes: [
              {
                ...validVisionResponse.items[0]!.outcomes[0],
                findings: [
                  {
                    ...validVisionResponse.items[0]!.outcomes[0]!.findings[0],
                    metadata: { age: 30, gender: "F" },
                  },
                ],
              },
            ],
          },
        ],
      })
    ) as unknown as typeof fetch;

    const client = new FaceRecognitionClient("http://vision.test", 100);
    const result = await client.detectFaces({ image_base64: encodedImage });

    expect(result.faces[0]).toEqual({
      bbox: [64, 96, 320, 384],
      embedding: validEmbedding,
      det_score: 0.98,
    });
  });

  it("maps isolated capability failures without accepting a partial face result", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({
        ...validVisionResponse,
        items: [
          {
            ...validVisionResponse.items[0],
            width: null,
            height: null,
            outcomes: [
              {
                capability: "faces",
                status: "error",
                error: { code: "MODEL_BUSY", message: "try again" },
              },
            ],
          },
        ],
      })
    ) as unknown as typeof fetch;

    const client = new FaceRecognitionClient("http://vision.test", 100);
    await expect(
      client.detectFaces({ image_base64: encodedImage })
    ).rejects.toThrow("Face analysis failed (MODEL_BUSY): try again");
  });

  it("always clears the transport timer when the request fails", async () => {
    const clearTimeoutMock = mock((timer: ReturnType<typeof setTimeout>) =>
      originalClearTimeout(timer)
    );
    globalThis.clearTimeout =
      clearTimeoutMock as unknown as typeof clearTimeout;
    globalThis.fetch = mock(async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;

    const client = new FaceRecognitionClient("http://vision.test", 100);
    await expect(
      client.detectFaces({ image_base64: encodedImage })
    ).rejects.toThrow("Vision service unavailable");
    expect(clearTimeoutMock).toHaveBeenCalledTimes(1);
  });
});
