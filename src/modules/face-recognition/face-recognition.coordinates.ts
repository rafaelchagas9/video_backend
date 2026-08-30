export type PixelFaceBox = [number, number, number, number];
export type NormalizedFaceBox = [number, number, number, number];

function assertImageDimensions(width: number, height: number): void {
  if (
    !Number.isFinite(width) ||
    width <= 0 ||
    !Number.isFinite(height) ||
    height <= 0
  ) {
    throw new Error(
      "Face bounding-box image dimensions must be positive and finite"
    );
  }
}

function assertFaceBox(box: readonly number[]): asserts box is PixelFaceBox {
  if (
    box.length !== 4 ||
    box.some((coordinate) => !Number.isFinite(coordinate))
  ) {
    throw new Error("Face bounding box must contain four finite coordinates");
  }
}

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function assertOrdered(box: PixelFaceBox): void {
  if (box[2] <= box[0] || box[3] <= box[1]) {
    throw new Error("Face bounding box must have positive width and height");
  }
}

export function normalizeFaceBox(
  pixelBox: readonly number[],
  imageWidth: number,
  imageHeight: number
): NormalizedFaceBox {
  assertImageDimensions(imageWidth, imageHeight);
  assertFaceBox(pixelBox);

  const normalized: NormalizedFaceBox = [
    clampUnit(pixelBox[0] / imageWidth),
    clampUnit(pixelBox[1] / imageHeight),
    clampUnit(pixelBox[2] / imageWidth),
    clampUnit(pixelBox[3] / imageHeight),
  ];
  assertOrdered(normalized);
  return normalized;
}

export function normalizedFaceBoxToPixels(
  normalizedBox: readonly number[],
  imageWidth: number,
  imageHeight: number
): PixelFaceBox {
  assertImageDimensions(imageWidth, imageHeight);
  assertFaceBox(normalizedBox);

  if (normalizedBox.some((coordinate) => coordinate < 0 || coordinate > 1)) {
    throw new Error(
      "Normalized face bounding box must stay between zero and one"
    );
  }
  assertOrdered(normalizedBox);

  return [
    Math.round(normalizedBox[0] * imageWidth),
    Math.round(normalizedBox[1] * imageHeight),
    Math.round(normalizedBox[2] * imageWidth),
    Math.round(normalizedBox[3] * imageHeight),
  ];
}

/**
 * New detections are normalized. Rows written before that contract stored raw
 * pixels without their source dimensions, so they can only be preserved as a
 * best-effort unscaled fallback until reanalysis replaces them.
 */
export function persistedFaceBoxToPixels(
  persistedBox: readonly number[],
  imageWidth: number,
  imageHeight: number
): PixelFaceBox {
  assertFaceBox(persistedBox);
  if (persistedBox.every((coordinate) => coordinate >= 0 && coordinate <= 1)) {
    return normalizedFaceBoxToPixels(persistedBox, imageWidth, imageHeight);
  }

  assertOrdered(persistedBox);
  return persistedBox.map((coordinate) =>
    Math.round(coordinate)
  ) as PixelFaceBox;
}
