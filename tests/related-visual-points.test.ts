import { describe, expect, it } from "bun:test";
import { folderOf, visualPoints } from "@/modules/videos/related-signals";

describe("visual related points", () => {
  it("scales points inside the band under the best distinct neighbour", () => {
    const points = visualPoints([
      { videoId: 1, score: 0.999 },
      { videoId: 2, score: 0.7 },
      { videoId: 3, score: 0.64 },
      { videoId: 4, score: 0.5 },
    ]);
    expect(points.has(1)).toBe(false);
    expect(points.get(2)).toBe(48);
    expect(points.get(3)).toBe(32);
    expect(points.has(4)).toBe(false);
  });
  it("gives nothing when even the best match is weak", () => {
    expect(visualPoints([{ videoId: 2, score: 0.2 }]).size).toBe(0);
    expect(visualPoints([]).size).toBe(0);
  });
  it("reads the folder of posix and windows paths", () => {
    expect(folderOf("/media/a/b.mp4")).toBe("/media/a");
    expect(folderOf("C:\\media\\b.mp4")).toBe("C:\\media");
    expect(folderOf("b.mp4")).toBe("");
  });
});
