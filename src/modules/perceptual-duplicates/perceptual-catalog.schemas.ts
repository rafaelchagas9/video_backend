import { z } from "zod";
import {
  engineMatchSchema,
  intervalCoverage,
} from "./perceptual-duplicates.schemas";

import { perceptualAssessmentSchema } from "./perceptual-relevance";

export const LEGACY_CATALOG_REVISION = "sscd-regions-sift-temporal-v2";
export const PERCEPTUAL_INDEX_REVISION = "sscd-ivfpq-dense-v3";
export const CATALOG_REVISION = "sscd-temporal-v4";
export const perceptualCatalogResultSchema = z
  .object({
    version: z.literal(1),
    revision: z.literal(CATALOG_REVISION),
    video_id: z.number().int().positive(),
    compared_videos: z.number().int().nonnegative(),
    retrieval_references: z.number().int().nonnegative().optional(),
    retrieval_candidates: z.number().int().nonnegative().optional(),
    retrieval_truncated: z.boolean().optional(),
    skipped_references: z.number().int().nonnegative(),
    match_count: z.number().int().nonnegative(),
    matches: z.array(engineMatchSchema).max(50),
    truncated_matches: z.boolean(),
    candidate_limited_pairs: z.number().int().nonnegative(),
  })
  .strict();
export type PerceptualCatalogResult = z.infer<
  typeof perceptualCatalogResultSchema
>;
export const perceptualCatalogResultsSchema = z.object({
  items: z.array(
    perceptualCatalogResultSchema.extend({
      matches: z
        .array(
          engineMatchSchema.safeExtend({
            assessment: perceptualAssessmentSchema,
          })
        )
        .max(50),
    })
  ),
  assessment_revision: z.string(),
  diagnostics: z.object({
    candidate_limited_pairs: z.number().int().nonnegative(),
    truncated_videos: z.number().int().nonnegative(),
    suppressed_matches: z.number().int().nonnegative(),
    retrieval_limited_videos: z.number().int().nonnegative().optional(),
  }),
  video_labels: z.record(z.string(), z.string()).optional(),
  total: z.number().int().nonnegative(),
  limit: z.number().int(),
  offset: z.number().int(),
});
export type PerceptualCatalogResults = z.infer<
  typeof perceptualCatalogResultsSchema
>;

export type HistoricalCatalogResult = Omit<
  PerceptualCatalogResult,
  "revision"
> & {
  revision: typeof CATALOG_REVISION | typeof LEGACY_CATALOG_REVISION;
};
export function validateCatalogResult(
  value: unknown,
  videoId: number,
  durations: Map<number, number>,
  allowLegacy?: false
): PerceptualCatalogResult;
export function validateCatalogResult(
  value: unknown,
  videoId: number,
  durations: Map<number, number>,
  allowLegacy: true
): HistoricalCatalogResult;
export function validateCatalogResult(
  value: unknown,
  videoId: number,
  durations: Map<number, number>,
  allowLegacy = false
): HistoricalCatalogResult {
  // Legacy is accepted only by the offline incident replay, never API/catalog
  // readers. Preserve its revision; replay cannot promote it to v3 evidence.
  const result = (
    allowLegacy
      ? perceptualCatalogResultSchema.extend({
          revision: z.enum([CATALOG_REVISION, LEGACY_CATALOG_REVISION]),
        })
      : perceptualCatalogResultSchema
  ).parse(value);
  if (
    result.video_id !== videoId ||
    result.match_count > result.compared_videos ||
    result.matches.length !== Math.min(50, result.match_count) ||
    result.truncated_matches !== result.match_count > 50 ||
    result.candidate_limited_pairs > result.compared_videos
  )
    throw new Error("Invalid catalogue result counts");
  const pairs = new Set<string>();
  for (const match of result.matches) {
    const a = durations.get(match.video_a);
    const b = durations.get(match.video_b);
    const pair = [match.video_a, match.video_b]
      .sort((left, right) => left - right)
      .join(":");
    if (
      !a ||
      !b ||
      (match.video_a !== videoId && match.video_b !== videoId) ||
      pairs.has(pair) ||
      match.segments.some(
        (segment) => segment.a_end > a || segment.b_end > b
      ) ||
      match.status !==
        (match.segments.some((segment) => segment.status === "ambiguous")
          ? "ambiguous"
          : "verified") ||
      Math.abs(
        match.coverage_a -
          intervalCoverage(
            match.segments.map((segment) => [segment.a_start, segment.a_end]),
            a
          )
      ) > 1e-6 ||
      Math.abs(
        match.coverage_b -
          intervalCoverage(
            match.segments.map((segment) => [segment.b_start, segment.b_end]),
            b
          )
      ) > 1e-6
    ) {
      throw new Error("Invalid catalogue match evidence");
    }
    pairs.add(pair);
  }
  return result;
}
