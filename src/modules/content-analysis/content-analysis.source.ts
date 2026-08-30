import { createHash } from "node:crypto";
import type {
  ContentAnalysisIntent,
  ContentAnalysisRevisions,
  ContentAnalysisVideoSource,
} from "./content-analysis.types";

export function contentAnalysisSourceFingerprint(
  source: ContentAnalysisVideoSource
): string {
  return source.sourceFingerprint;
}

export function assertContentAnalysisSource(
  source: ContentAnalysisVideoSource | null
): asserts source is ContentAnalysisVideoSource & { durationSeconds: number } {
  if (!source) throw new Error("Video source is unavailable");
  if (
    !Number.isFinite(source.durationSeconds) ||
    source.durationSeconds === null ||
    source.durationSeconds <= 0
  ) {
    throw new Error("Video source has no finite positive duration");
  }
}

export function contentAnalysisSemanticKey(
  input: Pick<
    ContentAnalysisIntent,
    | "videoId"
    | "userId"
    | "kind"
    | "profile"
    | "requestedCategories"
    | "sourceFingerprint"
    | "sourceDurationSeconds"
  > &
    ContentAnalysisRevisions
): string {
  const canonical = JSON.stringify({
    videoId: input.videoId,
    userId: input.userId,
    kind: input.kind,
    sourceFingerprint: input.sourceFingerprint,
    sourceDurationSeconds: input.sourceDurationSeconds,
    profile: input.profile,
    requestedCategories: [...input.requestedCategories].sort(),
    analyzerRevision: input.analyzerRevision,
    modelRevision: input.modelRevision,
    taxonomyRevision: input.taxonomyRevision,
    configRevision: input.configRevision,
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

export function contentAnalysisRequestDigest(input: {
  semanticGenerationKey: string;
  force: boolean;
}): string {
  return `sha256:${createHash("sha256")
    .update(
      JSON.stringify({
        semanticGenerationKey: input.semanticGenerationKey,
        force: input.force,
      })
    )
    .digest("hex")}`;
}

export function sourceMatchesRun(
  source: ContentAnalysisVideoSource,
  expected: { sourceFingerprint: string; sourceDurationSeconds: number }
): boolean {
  const durationSeconds = source.durationSeconds;
  const durationToleranceSeconds = Math.max(
    0.01,
    Math.abs(expected.sourceDurationSeconds) * 1e-6
  );
  return (
    contentAnalysisSourceFingerprint(source) === expected.sourceFingerprint &&
    typeof durationSeconds === "number" &&
    Number.isFinite(durationSeconds) &&
    Number.isFinite(expected.sourceDurationSeconds) &&
    Math.abs(durationSeconds - expected.sourceDurationSeconds) <=
      durationToleranceSeconds
  );
}
