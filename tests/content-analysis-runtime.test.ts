import { describe, expect, it } from "bun:test";
import { contentAnalysisRevisionsFromCapabilities } from "@/modules/content-analysis/content-analysis.revisions";
import { RetryableContentAnalysisError } from "@/modules/content-analysis";

const manifest = {
  version: "1" as const,
  capabilities: [
    {
      name: "nudity",
      ready: true,
      state: "ready",
      providers: ["MIGraphXExecutionProvider", "CPUExecutionProvider"],
      modelRevision:
        "nudenet-3.4.2/640m@sha256:04fe3d77980780c1f8297dc6d7f942fd5b3abe6942a188f742a85241e4f634eb",
      taxonomyRevision: "nudenet-selected-11-v1",
      maxBatchItems: 16,
      maxBatchBytes: 32 * 1024 * 1024,
      maxImageBytes: 10 * 1024 * 1024,
      maxImagePixels: 40_000_000,
    },
  ],
};

describe("content analysis runtime revisions", () => {
  it("persists the exact live model and taxonomy revisions", () => {
    expect(contentAnalysisRevisionsFromCapabilities(manifest)).toEqual({
      analyzerRevision: "nudity-processor-v4",
      modelRevision:
        "nudenet-3.4.2/640m@sha256:04fe3d77980780c1f8297dc6d7f942fd5b3abe6942a188f742a85241e4f634eb",
      taxonomyRevision: "nudenet-selected-11-v1",
      configRevision: "nudity-processor-v4",
    });
  });

  it("fails closed when the GPU provider is absent", () => {
    expect(() =>
      contentAnalysisRevisionsFromCapabilities({
        ...manifest,
        capabilities: [
          { ...manifest.capabilities[0]!, providers: ["CPUExecutionProvider"] },
        ],
      })
    ).toThrow(RetryableContentAnalysisError);
  });
});
