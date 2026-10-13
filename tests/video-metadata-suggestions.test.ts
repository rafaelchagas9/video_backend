import { describe, expect, it } from "bun:test";
import {
  nameMatches,
  normalizeText,
  rankSuggestions,
  themeMatches,
  voteMatches,
} from "@/modules/videos/video-suggestions";

const creators = [
  { id: 1, name: "Valerie Broussard" },
  { id: 2, name: "Ava" },
  { id: 3, name: "Zoë Kravitz", aliases: ["Zoe K"] },
  { id: 4, name: "Madison" },
];

describe("metadata suggestions", () => {
  it("normalizes accents and punctuation into padded words", () => {
    expect(normalizeText("Zoë-Kravitz [4K].mp4")).toBe(" zoe kravitz 4k mp4 ");
  });
  it("matches whole names in the title and skips short single words", () => {
    const hits = nameMatches("creator", "Awaken (ft. Valerie Broussard) with Ava and zoe k", creators);
    expect(hits.map((hit) => hit.id)).toEqual([1, 3]);
    expect(hits[0]!.confidence).toBeGreaterThan(0.7);
    expect(nameMatches("creator", "Madisonville tour", creators)).toEqual([]);
    expect(nameMatches("creator", "madison live", creators).map((hit) => hit.id)).toEqual([4]);
  });
  it("matches tags named like a theme", () => {
    const tags = [{ id: 7, name: "Magic" }, { id: 8, name: "Esport" }];
    expect(themeMatches("Esports, War, Magic", tags).map((hit) => hit.id)).toEqual([7]);
  });
  it("needs agreement from several neighbours", () => {
    const votes = voteMatches(
      [{ weight: 0.8, ids: [1, 2] }, { weight: 0.7, ids: [1] }, { weight: 0.6, ids: [3] }],
      "similar",
      { minSupport: 2, minShare: 0.3, maxConfidence: 0.7, noun: "look-alike videos" }
    );
    expect(votes.map((vote) => vote.id)).toEqual([1]);
    expect(votes[0]!.detail).toBe("On 2 of 3 look-alike videos");
  });
  it("merges reasons, rewards agreement and drops linked entities", () => {
    const catalog = new Map(creators.map((creator) => [creator.id, creator]));
    const ranked = rankSuggestions(
      [
        { id: 1, reason: "similar", confidence: 0.5, detail: "On 3 of 5 look-alike videos" },
        { id: 1, reason: "title", confidence: 0.8, detail: "In the title" },
        { id: 2, reason: "face", confidence: 0.9, detail: "Face seen 4 times" },
        { id: 99, reason: "title", confidence: 0.9, detail: "Unknown entity" },
      ],
      catalog,
      new Set([2]),
      5
    );
    expect(ranked).toHaveLength(1);
    expect(ranked[0]).toMatchObject({ id: 1, reasons: ["title", "similar"], confidence: 0.9, detail: "In the title" });
  });
});
