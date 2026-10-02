import { describe, expect, it } from "bun:test";
import { buildCleanupFocusGroups } from "@/modules/cleanup/cleanup.focus";
import type { CleanupCandidate } from "@/modules/cleanup/cleanup.types";
const video = (
  id: number,
  size: number,
  disposition: CleanupCandidate["disposition"] = "unreviewed",
  eligible = true
) => ({ id, file_size_bytes: size, disposition, eligible }) as CleanupCandidate;
describe("storage focus", () => {
  it("deduplicates each group, allows overlap, and ranks remaining bytes", () => {
    const rows = [
      { video_id: 1, kind: "creator" as const, id: 1, name: "A" },
      { video_id: 1, kind: "creator" as const, id: 1, name: "A" },
      { video_id: 1, kind: "studio" as const, id: 2, name: "B" },
      { video_id: 2, kind: "creator" as const, id: 1, name: "A" },
      { video_id: 3, kind: "studio" as const, id: 2, name: "B" },
    ];
    expect(
      buildCleanupFocusGroups(
        [video(1, 100), video(2, 300), video(3, 500, "keep")],
        rows
      )
    ).toEqual([
      {
        kind: "creator",
        id: 1,
        name: "A",
        remaining_count: 2,
        remaining_bytes: 400,
        reviewed_count: 0,
      },
      {
        kind: "studio",
        id: 2,
        name: "B",
        remaining_count: 1,
        remaining_bytes: 100,
        reviewed_count: 1,
      },
    ]);
  });
  it("excludes ineligible or missing files and retains completed groups", () => {
    expect(
      buildCleanupFocusGroups(
        [video(1, 100, "unreviewed", false), video(2, 200, "keep")],
        [
          { video_id: 1, kind: "creator", id: 1, name: "A" },
          { video_id: 2, kind: "studio", id: 2, name: "B" },
          { video_id: 99, kind: "directory", id: 1, name: "D" },
        ]
      )
    ).toEqual([
      {
        kind: "studio",
        id: 2,
        name: "B",
        remaining_count: 0,
        remaining_bytes: 0,
        reviewed_count: 1,
      },
    ]);
  });
});
