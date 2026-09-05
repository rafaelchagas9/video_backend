import type { DemoContentAnalysisScenario } from "@/database/demo/scenarios";
import type {
  ContentAnalysisEventDraft,
  ContentAnalysisProfile,
} from "./content-analysis.types";
import type { SystemBookmarkCategoryKey } from "@/modules/bookmarks/bookmark-categories.constants";

const EVENT_COUNTS: Readonly<Record<DemoContentAnalysisScenario, number>> = {
  empty: 0,
  singleton: 1,
  typical: 8,
  dense: 28,
  stress: 80,
};

const PROFILE_INTERVAL_SECONDS: Readonly<
  Record<ContentAnalysisProfile, number>
> = {
  fast: 8,
  balanced: 2,
  thorough: 1,
};

export interface DemoContentAnalysisFixture {
  sampledFrames: number;
  positiveFrames: number;
  events: ContentAnalysisEventDraft[];
}

export interface BuildDemoContentAnalysisFixtureInput {
  scenario: DemoContentAnalysisScenario;
  durationSeconds: number;
  profile: ContentAnalysisProfile;
  requestedCategories: readonly SystemBookmarkCategoryKey[];
  generationKey: string;
}

function roundSeconds(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function confidence(index: number): number {
  return Math.min(0.98, 0.72 + ((index * 7) % 25) / 100);
}

export function buildDemoContentAnalysisFixture(
  input: BuildDemoContentAnalysisFixtureInput
): DemoContentAnalysisFixture {
  const eventCount = EVENT_COUNTS[input.scenario];
  const sampledFrames = Math.max(
    eventCount * 4,
    Math.ceil(input.durationSeconds / PROFILE_INTERVAL_SECONDS[input.profile])
  );
  if (eventCount === 0) {
    return { sampledFrames, positiveFrames: 0, events: [] };
  }

  const clusterSize =
    input.scenario === "stress" ? 8 : input.scenario === "dense" ? 5 : 3;
  const durationWeights = Array.from(
    { length: eventCount },
    (_, index) => 1 + (index % 5) * 0.35
  );
  const gapWeights = Array.from({ length: eventCount + 1 }, (_, index) => {
    if (index === 0 || index === eventCount) return 1.5;
    return index % clusterSize === 0 ? 2.2 : 0.18;
  });
  const totalWeight =
    durationWeights.reduce((sum, weight) => sum + weight, 0) +
    gapWeights.reduce((sum, weight) => sum + weight, 0);
  const secondsPerWeight = input.durationSeconds / totalWeight;
  let cursor = gapWeights[0]! * secondsPerWeight;

  const events = durationWeights.map((durationWeight, index) => {
    const startSeconds = cursor;
    const endSeconds = Math.min(
      input.durationSeconds,
      startSeconds + durationWeight * secondsPerWeight
    );
    const peakRatio = 0.25 + (index % 5) * 0.1;
    const peakSeconds = startSeconds + (endSeconds - startSeconds) * peakRatio;
    const categoryCount =
      input.requestedCategories.length >= 3 && index % 7 === 0
        ? 3
        : input.requestedCategories.length >= 2 && index % 3 === 0
          ? 2
          : 1;
    const categories = Array.from(
      { length: categoryCount },
      (_, categoryOffset) =>
        input.requestedCategories[
          (index + categoryOffset) % input.requestedCategories.length
        ]!
    );
    const categorySummary = categories.map((category, categoryIndex) => {
      const maxScore = confidence(index + categoryIndex);
      return {
        category,
        count: 2 + ((index + categoryIndex) % 5),
        maxScore,
        meanScore: Math.max(0, Math.round((maxScore - 0.08) * 100) / 100),
        providerLabel: "demo-synthetic",
      };
    });
    cursor = endSeconds + gapWeights[index + 1]! * secondsPerWeight;
    return {
      generationKey: `${input.generationKey}:${input.scenario}:${index + 1}`,
      startSeconds: roundSeconds(startSeconds),
      peakSeconds: roundSeconds(peakSeconds),
      endSeconds: roundSeconds(endSeconds),
      categorySummary,
    };
  });

  return {
    sampledFrames,
    positiveFrames: Math.min(
      sampledFrames,
      eventCount * 2 + Math.floor(eventCount / 3)
    ),
    events,
  };
}
