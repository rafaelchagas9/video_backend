import { DEFAULT_NUDITY_PROCESSOR_CONFIG } from "./content-analysis.processor";
import { RetryableContentAnalysisError } from "./content-analysis.store";
import type { ContentAnalysisRevisions } from "./content-analysis.types";
import type { VisionCapabilities } from "./visual-inference.types";

const REQUIRED_GPU_PROVIDER = "MIGraphXExecutionProvider";

export function contentAnalysisRevisionsFromCapabilities(
  manifest: VisionCapabilities
): ContentAnalysisRevisions {
  const capability = manifest.capabilities.find(
    (candidate) => candidate.name === "nudity"
  );
  if (
    !capability?.ready ||
    !capability.modelRevision ||
    !capability.taxonomyRevision ||
    !capability.providers.includes(REQUIRED_GPU_PROVIDER)
  ) {
    throw new RetryableContentAnalysisError(
      "CAPABILITY_NOT_READY",
      "GPU nudity analysis capability is not ready"
    );
  }
  return {
    analyzerRevision: DEFAULT_NUDITY_PROCESSOR_CONFIG.analyzerRevision,
    modelRevision: capability.modelRevision,
    taxonomyRevision: capability.taxonomyRevision,
    configRevision: DEFAULT_NUDITY_PROCESSOR_CONFIG.revision,
  };
}
