import { describe, expect, it } from "bun:test";
import {
  applyCandidatePolicy,
  isSingleNamePerformer,
  parseGenderList,
  parseTagPatterns,
} from "@/modules/enrichment/enrichment.policy";
import type { Candidate } from "@/modules/enrichment/enrichment.types";

const performer = (name: string, raw: Record<string, unknown> = {}): Candidate => ({
  type: "performer",
  value: name,
  source: "stashdb",
  raw: { source: "stashdb", ...raw },
});
const tag = (name: string): Candidate => ({ type: "tag", value: name, source: "stashdb" });

describe("enrichment policy (Stash Identify rules)", () => {
  it("keeps only allowed genders, and performers whose gender is unknown", () => {
    const outcome = applyCandidatePolicy(
      [
        performer("Jane Doe", { gender: "FEMALE" }),
        performer("John Doe", { gender: "MALE" }),
        performer("Alex Doe"),
      ],
      { performerGenders: parseGenderList("female, transgender_female"), excludeTagPatterns: [], skipSingleNamePerformers: false }
    );
    expect(outcome.kept.map((c) => c.value)).toEqual(["Jane Doe", "Alex Doe"]);
    expect(outcome.droppedPerformers).toEqual(["John Doe"]);
  });

  it("drops excluded tags case-insensitively and ignores invalid patterns", () => {
    const patterns = parseTagPatterns("^4k$\n(unclosed\n  \nwatermark");
    expect(patterns).toHaveLength(2);
    const outcome = applyCandidatePolicy([tag("4K"), tag("Watermarked"), tag("Outdoors")], {
      performerGenders: null,
      excludeTagPatterns: patterns,
      skipSingleNamePerformers: false,
    });
    expect(outcome.kept.map((c) => c.value)).toEqual(["Outdoors"]);
    expect(outcome.droppedTags).toEqual(["4K", "Watermarked"]);
  });

  it("marks single-name performers without disambiguation as needing a choice", () => {
    expect(isSingleNamePerformer("Mia", null)).toBe(true);
    expect(isSingleNamePerformer("Mia", "2015 debut")).toBe(false);
    expect(isSingleNamePerformer("Mia Doe")).toBe(false);
    const outcome = applyCandidatePolicy([performer("Mia"), performer("Mia", { disambiguation: "UK" })], {
      performerGenders: null,
      excludeTagPatterns: [],
      skipSingleNamePerformers: true,
    });
    expect((outcome.kept[0]!.raw as { requires_choice?: string }).requires_choice).toBe("single_name");
    expect((outcome.kept[1]!.raw as { requires_choice?: string }).requires_choice).toBeUndefined();
  });

  it("treats an empty gender list as every gender", () => {
    expect(parseGenderList("")).toBeNull();
    expect(parseGenderList("unknown")).toBeNull();
  });
});
