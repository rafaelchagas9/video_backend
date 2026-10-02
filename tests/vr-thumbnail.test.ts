import { describe, expect, test } from "bun:test";
import sharp from "sharp";
import {
  resolveVrThumbnail,
  VR_PLACEHOLDER_PNG,
} from "@/modules/vr/vr.thumbnail";
describe("curated artwork for native VR catalogs", () => {
  test("prefers curated card over poster and legacy screenshot", async () => {
    const looked: number[] = [];
    let legacy = false;
    expect(
      await resolveVrThumbnail({
        artwork: async () => [
          { id: 2, variant: "poster" },
          { id: 1, variant: "card" },
        ],
        assetPath: async (id) => {
          looked.push(id);
          return `${id}.webp`;
        },
        legacyPath: async () => {
          legacy = true;
          return "legacy.jpg";
        },
        exists: () => true,
      })
    ).toBe("1.webp");
    expect(looked).toEqual([1]);
    expect(legacy).toBe(false);
  });
  test("missing card falls back to existing poster; title vector is skipped", async () => {
    expect(
      await resolveVrThumbnail({
        artwork: async () => [
          { id: 9, variant: "title" },
          { id: 1, variant: "card" },
          { id: 2, variant: "poster" },
        ],
        assetPath: async (id) => `${id}.webp`,
        legacyPath: async () => null,
        exists: (path) => path === "2.webp",
      })
    ).toBe("2.webp");
  });
  test("absence of curated assets uses legacy then native PNG fallback", async () => {
    const deps = {
      artwork: async () => [],
      assetPath: async () => {
        throw new Error("No asset expected");
      },
      legacyPath: async () => "legacy.jpg",
      exists: (path: string) => path === "legacy.jpg",
    };
    expect(await resolveVrThumbnail(deps)).toBe("legacy.jpg");
    expect(
      await resolveVrThumbnail({ ...deps, exists: () => false })
    ).toBeNull();
    const info = await sharp(VR_PLACEHOLDER_PNG).metadata();
    expect(info.format).toBe("png");
    expect(info.width).toBe(320);
    expect(info.height).toBe(180);
  });
});
