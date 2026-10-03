/**
 * Candidate rules borrowed from Stash's Identify task (internal/identify):
 * which performer genders a scene proposes, which tags are never proposed,
 * and when a new performer needs a human choice instead of being created.
 */

import { settingsService } from "@/modules/settings/settings.service";
import { logger } from "@/utils/logger";
import type { Candidate, RelationalRaw } from "./enrichment.types";

/** stash-box GenderEnum values. */
export const PERFORMER_GENDERS = [
  "FEMALE",
  "MALE",
  "TRANSGENDER_FEMALE",
  "TRANSGENDER_MALE",
  "INTERSEX",
  "NON_BINARY",
] as const;

export interface EnrichmentPolicy {
  /** Null = every gender, including performers whose gender is unknown. */
  performerGenders: Set<string> | null;
  excludeTagPatterns: RegExp[];
  skipSingleNamePerformers: boolean;
}

export interface PolicyOutcome {
  kept: Candidate[];
  droppedPerformers: string[];
  droppedTags: string[];
}

export function parseGenderList(value: unknown): Set<string> | null {
  const genders = String(value ?? "")
    .split(",")
    .map((g) => g.trim().toUpperCase())
    .filter((g) => (PERFORMER_GENDERS as readonly string[]).includes(g));
  return genders.length > 0 ? new Set(genders) : null;
}

/** One case-insensitive pattern per line; invalid lines are skipped. */
export function parseTagPatterns(value: unknown): RegExp[] {
  const patterns: RegExp[] = [];
  for (const line of String(value ?? "").split("\n")) {
    const source = line.trim();
    if (!source) continue;
    try {
      patterns.push(new RegExp(source, "i"));
    } catch {
      logger.warn({ pattern: source }, "Ignoring invalid tag exclude pattern");
    }
  }
  return patterns;
}

export async function loadEnrichmentPolicy(): Promise<EnrichmentPolicy> {
  const [genders, patterns, skipSingle] = await Promise.all([
    settingsService.getValue("enrichment_performer_genders"),
    settingsService.getValue("enrichment_exclude_tag_patterns"),
    settingsService.getValue("enrichment_skip_single_name_performers"),
  ]);
  return {
    performerGenders: parseGenderList(genders),
    excludeTagPatterns: parseTagPatterns(patterns),
    skipSingleNamePerformers: skipSingle === true || skipSingle === "true",
  };
}

/** "Mia" with no disambiguation: too ambiguous to create automatically. */
export function isSingleNamePerformer(
  name: string,
  disambiguation?: string | null
): boolean {
  return !/\s/.test(name.trim()) && !disambiguation?.trim();
}

/**
 * Drop performers of excluded genders (unknown gender is kept, as in Stash)
 * and excluded tags; mark single-name performers as needing a choice.
 */
export function applyCandidatePolicy(
  candidates: Candidate[],
  policy: EnrichmentPolicy
): PolicyOutcome {
  const outcome: PolicyOutcome = {
    kept: [],
    droppedPerformers: [],
    droppedTags: [],
  };
  for (const candidate of candidates) {
    const raw = (candidate.raw ?? {}) as RelationalRaw;
    if (candidate.type === "performer") {
      const gender = raw.gender?.toUpperCase();
      if (policy.performerGenders && gender && !policy.performerGenders.has(gender)) {
        outcome.droppedPerformers.push(candidate.value);
        continue;
      }
      if (
        policy.skipSingleNamePerformers &&
        isSingleNamePerformer(candidate.value, raw.disambiguation)
      ) {
        outcome.kept.push({
          ...candidate,
          raw: { ...raw, requires_choice: "single_name" },
        });
        continue;
      }
    }
    if (
      candidate.type === "tag" &&
      policy.excludeTagPatterns.some((pattern) => pattern.test(candidate.value))
    ) {
      outcome.droppedTags.push(candidate.value);
      continue;
    }
    outcome.kept.push(candidate);
  }
  return outcome;
}
