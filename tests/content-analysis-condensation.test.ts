import { describe, expect, it } from "bun:test";
import {
  condenseNudityFindings,
  type NudityCondensationConfig,
  type TimestampedNudityFinding,
} from "@/modules/content-analysis/content-analysis.condensation";

const config: NudityCondensationConfig = {
  generationKeyPrefix: "analysis:42:v1",
  videoDurationSeconds: 120,
  selectedCategories: ["BUTTOCKS_EXPOSED"],
  thresholds: {
    BUTTOCKS_EXPOSED: { entryScore: 0.8, exitScore: 0.6 },
  },
  defaultThreshold: { entryScore: 0.85, exitScore: 0.65 },
  confirmationCount: 2,
  confirmationWindowSeconds: 1,
  negativeToleranceSeconds: 1,
  mergeGapSeconds: 2,
  preRollSeconds: 0,
  postRollSeconds: 0,
};

function finding(
  timestampSeconds: number,
  score: number,
  category: TimestampedNudityFinding["category"] = "BUTTOCKS_EXPOSED"
): TimestampedNudityFinding {
  return { timestampSeconds, category, score, providerLabel: category };
}

describe("condenseNudityFindings", () => {
  it("filters unselected labels and applies the selected category thresholds", () => {
    const events = condenseNudityFindings(
      [
        finding(1, 0.79),
        finding(2, 0.92, "FEET_EXPOSED"),
        finding(2.5, 0.99, "BELLY_EXPOSED"),
        finding(3, 0.81),
      ],
      {
        ...config,
        selectedCategories: ["BUTTOCKS_EXPOSED", "FEET_EXPOSED"],
        thresholds: {
          ...config.thresholds,
          FEET_EXPOSED: { entryScore: 0.95, exitScore: 0.75 },
        },
      }
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      startSeconds: 3,
      peakSeconds: 3,
      endSeconds: 3,
      categorySummary: [
        {
          category: "BUTTOCKS_EXPOSED",
          count: 1,
          maxScore: 0.81,
          meanScore: 0.81,
          providerLabel: "BUTTOCKS_EXPOSED",
        },
      ],
    });
  });

  it("opens on neighboring confirmations and keeps a span through short confidence jitter", () => {
    const events = condenseNudityFindings(
      [
        finding(10, 0.7),
        finding(10.5, 0.72),
        finding(11, 0.2),
        finding(11.5, 0.7),
        finding(13, 0.2),
        finding(15, 0.9),
      ],
      config
    );

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      startSeconds: 10,
      peakSeconds: 10.5,
      endSeconds: 11.5,
      categorySummary: [
        {
          category: "BUTTOCKS_EXPOSED",
          count: 3,
          maxScore: 0.72,
          meanScore: 0.7066666666666667,
        },
      ],
    });
    expect(events[1]).toMatchObject({
      startSeconds: 15,
      peakSeconds: 15,
      endSeconds: 15,
    });
  });

  it("merges adjacent categories, adds bounded roll, and chooses one deterministic peak", () => {
    const input = [
      finding(1, 0.9),
      finding(2, 0.7),
      finding(3.5, 0.95, "FEMALE_BREAST_EXPOSED"),
      finding(4, 0.7, "FEMALE_BREAST_EXPOSED"),
      finding(119, 0.99, "FEET_EXPOSED"),
    ];
    const mergeConfig: NudityCondensationConfig = {
      ...config,
      selectedCategories: [
        "FEET_EXPOSED",
        "FEMALE_BREAST_EXPOSED",
        "BUTTOCKS_EXPOSED",
      ],
      thresholds: {
        ...config.thresholds,
        FEMALE_BREAST_EXPOSED: { entryScore: 0.8, exitScore: 0.6 },
        FEET_EXPOSED: { entryScore: 0.8, exitScore: 0.6 },
      },
      preRollSeconds: 3,
      postRollSeconds: 5,
    };

    const events = condenseNudityFindings(input, mergeConfig);
    const reversed = condenseNudityFindings([...input].reverse(), mergeConfig);

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      startSeconds: 0,
      peakSeconds: 3.5,
      endSeconds: 9,
      categorySummary: [
        {
          category: "BUTTOCKS_EXPOSED",
          count: 2,
          maxScore: 0.9,
          meanScore: 0.8,
        },
        {
          category: "FEMALE_BREAST_EXPOSED",
          count: 2,
          maxScore: 0.95,
          meanScore: 0.825,
        },
      ],
    });
    expect(events[1]).toMatchObject({
      startSeconds: 116,
      peakSeconds: 119,
      endSeconds: 120,
    });
    expect(reversed).toEqual(events);
    expect(events[0].generationKey).toMatch(
      /^analysis:42:v1:episode:[a-f0-9]{24}$/
    );
  });

  it("counts temporal confirmations instead of duplicate boxes from one frame", () => {
    const duplicateFrame = [finding(20, 0.7), finding(20, 0.75)];

    expect(condenseNudityFindings(duplicateFrame, config)).toEqual([]);

    const events = condenseNudityFindings(
      [...duplicateFrame, finding(20.5, 0.7)],
      config
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      startSeconds: 20,
      peakSeconds: 20,
      endSeconds: 20.5,
      categorySummary: [
        {
          category: "BUTTOCKS_EXPOSED",
          count: 2,
          maxScore: 0.75,
          meanScore: 0.725,
        },
      ],
    });
  });

  it("breaks equal-confidence peak ties at the earliest timestamp", () => {
    const events = condenseNudityFindings(
      [finding(31, 0.9), finding(30, 0.9), finding(30.5, 0.7)],
      config
    );

    expect(events).toHaveLength(1);
    expect(events[0].peakSeconds).toBe(30);
  });
});
