import {
  VISION_CONTRACT_VERSION,
  visionBatchSchema,
  visionCapabilitiesSchema,
  visionFindingSchema,
  visionItemErrorSchema,
  validateVisionBatchResultForRequest,
} from "./visual-inference.schemas";
import type {
  VisualInferencePort,
  VisionBatch,
  VisionBatchResult,
  VisionCapabilities,
  VisionFinding,
  VisionItemError,
} from "./visual-inference.types";

export interface InMemoryVisualInferenceAdapterOptions {
  capabilities?: VisionCapabilities;
  findingsByItemId?: Record<string, VisionFinding[]>;
  errorsByItemId?: Record<string, Record<string, VisionItemError>>;
  dimensionsByItemId?: Record<string, { width: number; height: number }>;
}

export class InMemoryVisualInferenceAdapter implements VisualInferencePort {
  readonly requests: VisionBatch[] = [];
  private readonly configuredCapabilities: VisionCapabilities;
  private readonly findingsByItemId: Record<string, VisionFinding[]>;
  private readonly errorsByItemId: Record<
    string,
    Record<string, VisionItemError>
  >;
  private readonly dimensionsByItemId: Record<
    string,
    { width: number; height: number }
  >;

  constructor(options: InMemoryVisualInferenceAdapterOptions = {}) {
    this.configuredCapabilities = visionCapabilitiesSchema.parse(
      options.capabilities ?? {
        version: VISION_CONTRACT_VERSION,
        capabilities: [],
      }
    );
    this.findingsByItemId = Object.fromEntries(
      Object.entries(options.findingsByItemId ?? {}).map(([id, findings]) => [
        id,
        findings.map((finding) => visionFindingSchema.parse(finding)),
      ])
    );
    this.errorsByItemId = Object.fromEntries(
      Object.entries(options.errorsByItemId ?? {}).map(([id, errors]) => [
        id,
        Object.fromEntries(
          Object.entries(errors).map(([capability, error]) => [
            capability,
            visionItemErrorSchema.parse(error),
          ])
        ),
      ])
    );
    this.dimensionsByItemId = structuredClone(options.dimensionsByItemId ?? {});
  }

  async capabilities(signal?: AbortSignal): Promise<VisionCapabilities> {
    this.assertNotAborted(signal);
    return structuredClone(this.configuredCapabilities);
  }

  async analyzeBatch(
    input: VisionBatch,
    signal: AbortSignal
  ): Promise<VisionBatchResult> {
    this.assertNotAborted(signal);
    const batch = visionBatchSchema.parse(input);
    this.requests.push(batch);
    const result: VisionBatchResult = {
      version: VISION_CONTRACT_VERSION,
      items: batch.items.map((item) => {
        const dimensions = this.dimensionsByItemId[item.id];
        return {
          id: item.id,
          timestampSeconds: item.timestampSeconds,
          ...(dimensions ?? {}),
          outcomes: batch.capabilities.map((capability) => {
            const error = this.errorsByItemId[item.id]?.[capability];
            return error
              ? {
                  capability,
                  status: "error" as const,
                  error: { code: error.code, message: error.message },
                }
              : {
                  capability,
                  status: "ok" as const,
                  findings: structuredClone(
                    (this.findingsByItemId[item.id] ?? []).filter(
                      (finding) => finding.capability === capability
                    )
                  ),
                };
          }),
        };
      }),
    };
    return validateVisionBatchResultForRequest(batch, result);
  }

  private assertNotAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw new Error("Vision inference aborted", { cause: signal.reason });
    }
  }
}
