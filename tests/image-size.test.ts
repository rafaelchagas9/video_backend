import { describe, expect, it } from "bun:test";
import sharp from "sharp";
import { processPictureWithSize, readImageSize } from "@/utils/image-processing";

const canvas = (width: number, height: number, channels: 3 | 4 = 3) =>
  sharp({ create: { width, height, channels, background: { r: 90, g: 40, b: 20, alpha: 0.5 } } });

describe("readImageSize", () => {
  it("reads WebP (lossy, lossless, extended) from the first 4 KB", async () => {
    for (const [width, height] of [[3840, 2160], [1080, 1920], [777, 333]] as const) {
      const lossy = await canvas(width, height).webp().toBuffer();
      const lossless = await canvas(width, height).webp({ lossless: true }).toBuffer();
      const alpha = await canvas(width, height, 4).webp().toBuffer();
      for (const bytes of [lossy, lossless, alpha])
        expect(await readImageSize(bytes.subarray(0, 4096))).toEqual({ width, height });
    }
  });

  it("reports JPEG rotated by EXIF as the upright picture", async () => {
    const turned = await canvas(3840, 2160).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    expect(await readImageSize(turned.subarray(0, 4096))).toEqual({ width: 2160, height: 3840 });
  });

  it("returns null for bytes that are not an image", async () => {
    expect(await readImageSize(Buffer.from("<html>not an image</html>"))).toBeNull();
  });
});

describe("processPictureWithSize", () => {
  it("reports the stored size and the size the picture arrived at", async () => {
    const input = await canvas(3840, 2160).png().toBuffer();
    const result = await processPictureWithSize({ input, format: "webp", maxSize: 2160, quality: 80 });
    expect(result.size).toEqual({ width: 2160, height: 1215 });
    expect(result.source).toEqual({ width: 3840, height: 2160 });
  });
});
