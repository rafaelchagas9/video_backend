import { describe, expect, it } from "bun:test";
import {
  normalizeFaceBox,
  normalizedFaceBoxToPixels,
  persistedFaceBoxToPixels,
} from "@/modules/face-recognition/face-recognition.coordinates";

describe("face bounding-box coordinate contract", () => {
  it("maps a face detected in a resized frame onto the same region of a full-resolution frame", () => {
    const persistedBox = normalizeFaceBox([320, 180, 960, 540], 1280, 720);

    expect(persistedBox).toEqual([0.25, 0.25, 0.75, 0.75]);
    expect(normalizedFaceBoxToPixels(persistedBox, 3840, 2160)).toEqual([
      960, 540, 2880, 1620,
    ]);
  });

  it("keeps pre-migration pixel boxes readable as a best-effort legacy fallback", () => {
    expect(persistedFaceBoxToPixels([120, 80, 420, 480], 3840, 2160)).toEqual([
      120, 80, 420, 480,
    ]);
  });
});
