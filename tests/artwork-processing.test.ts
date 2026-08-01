import { describe, expect, test } from "bun:test";
import sharp from "sharp";
import {
  calculateArtworkCrop,
  extractArtworkPalette,
  isArtworkTitleEligible,
  renderArtworkTitle,
} from "@/modules/artwork/artwork.processing";

describe("artwork processing", () => {
  test("poster crop places the focal point on the upper third", () => {
    const crop = calculateArtworkCrop({
      sourceWidth: 900,
      sourceHeight: 1600,
      targetWidth: 400,
      targetHeight: 600,
      focalPoint: { x: 0.75, y: 0.3 },
      poster: true,
    });

    expect(crop.pixels.width / crop.pixels.height).toBeCloseTo(2 / 3, 2);
    const focalYInCrop = (0.3 - crop.normalized.y) / crop.normalized.height;
    expect(focalYInCrop).toBeCloseTo(1 / 3, 2);
  });

  test("palette returns raw swatches and OKLCH metadata", async () => {
    const pixels = Buffer.alloc(16 * 16 * 3);
    for (let index = 0; index < 16 * 16; index += 1) {
      const offset = index * 3;
      const red = index < 16 * 12;
      pixels[offset] = red ? 220 : 20;
      pixels[offset + 1] = 30;
      pixels[offset + 2] = red ? 40 : 220;
    }
    const image = await sharp(pixels, { raw: { width: 16, height: 16, channels: 3 } })
      .png()
      .toBuffer();
    const palette = await extractArtworkPalette(image);

    expect(palette.dominant).toMatch(/^#[a-f0-9]{6}$/);
    expect(palette.swatches.length).toBeGreaterThanOrEqual(2);
    expect(palette.swatches.length).toBeLessThanOrEqual(5);
    expect(palette.mean_oklch.l).toBeGreaterThan(0);
    expect(palette.is_neutral).toBeFalse();
  });

  test("title artwork is a tightly trimmed transparent white PNG", async () => {
    const result = await renderArtworkTitle("Sabrina Carpenter House Tour");
    expect(result).not.toBeNull();
    if (!result) throw new Error("Expected title artwork");

    expect(result.lines.length).toBeLessThanOrEqual(3);
    const metadata = await sharp(result.buffer).metadata();
    expect(metadata).toMatchObject({
      format: "png",
      hasAlpha: true,
      width: result.width,
      height: result.height,
    });

    const { data, info } = await sharp(result.buffer)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    let coloredPixels = 0;
    let nonWhitePixels = 0;
    let minX = info.width;
    let minY = info.height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < info.height; y += 1) {
      for (let x = 0; x < info.width; x += 1) {
        const offset = (y * info.width + x) * 4;
        if ((data[offset + 3] ?? 0) === 0) continue;
        coloredPixels += 1;
        if (data[offset] !== 255 || data[offset + 1] !== 255 || data[offset + 2] !== 255) {
          nonWhitePixels += 1;
        }
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
    expect(coloredPixels).toBeGreaterThan(0);
    expect(nonWhitePixels).toBe(0);
    expect({ minX, minY, maxX, maxY }).toEqual({
      minX: 0,
      minY: 0,
      maxX: info.width - 1,
      maxY: info.height - 1,
    });
  });

  test("title artwork skips empty and long titles", async () => {
    const longTitle = "A title that is intentionally longer than forty characters";
    expect(isArtworkTitleEligible("   ")).toBeFalse();
    expect(isArtworkTitleEligible(longTitle)).toBeFalse();
    expect(await renderArtworkTitle(longTitle)).toBeNull();
  });

  test("title renderer resolves the display font instead of missing glyphs", async () => {
    const result = await renderArtworkTitle("Substance");
    expect(result).not.toBeNull();
    if (!result) throw new Error("Expected title artwork");
    expect(result.width / result.height).toBeGreaterThan(4);
  });
});
