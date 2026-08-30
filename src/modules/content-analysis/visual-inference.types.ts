import type { z } from "zod";
import type {
  visionBatchItemResultSchema,
  visionBatchItemSchema,
  visionBatchResultSchema,
  visionBatchSchema,
  visionCapabilitiesSchema,
  visionCapabilityOutcomeSchema,
  visionCapabilitySchema,
  visionFindingSchema,
  visionItemErrorSchema,
} from "./visual-inference.schemas";

export type VisionFinding = z.infer<typeof visionFindingSchema>;
export type VisionItemError = z.infer<typeof visionItemErrorSchema>;
export type VisionCapabilityOutcome = z.infer<
  typeof visionCapabilityOutcomeSchema
>;
export type VisionBatchItem = z.infer<typeof visionBatchItemSchema>;
export type VisionBatch = z.infer<typeof visionBatchSchema>;
export type VisionBatchItemResult = z.infer<typeof visionBatchItemResultSchema>;
export type VisionBatchResult = z.infer<typeof visionBatchResultSchema>;
export type VisionCapability = z.infer<typeof visionCapabilitySchema>;
export type VisionCapabilities = z.infer<typeof visionCapabilitiesSchema>;

export interface VisualInferencePort {
  capabilities(signal?: AbortSignal): Promise<VisionCapabilities>;
  analyzeBatch(
    input: VisionBatch,
    signal: AbortSignal
  ): Promise<VisionBatchResult>;
}
