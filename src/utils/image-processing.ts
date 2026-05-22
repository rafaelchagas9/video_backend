import sharp from "sharp";
import { env } from "@/config/env";

type CropRectangle = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export async function cropFaceThumbnail(params: {
  inputPath: string;
  outputPath: string;
  faceBox: number[];
  imageWidth: number;
  imageHeight: number;
  paddingScale?: number;
}): Promise<{ outputPath: string }> {
  const {
    inputPath,
    outputPath,
    faceBox,
    imageWidth,
    imageHeight,
    paddingScale = 0.5,
  } = params;

  const [x1, y1, x2, y2] = faceBox;
  const faceWidth = Math.max(0, x2 - x1);
  const faceHeight = Math.max(0, y2 - y1);
  const faceSize = Math.max(faceWidth, faceHeight);
  const paddedSize = faceSize * (1 + paddingScale * 2);

  const centerX = x1 + faceWidth / 2;
  const centerY = y1 + faceHeight / 2;

  const cropSize = Math.min(
    Math.max(paddedSize, 1),
    Math.min(imageWidth, imageHeight),
  );

  let cropX = centerX - cropSize / 2;
  let cropY = centerY - cropSize / 2;

  if (cropX < 0) cropX = 0;
  if (cropY < 0) cropY = 0;
  if (cropX + cropSize > imageWidth) {
    cropX = Math.max(0, imageWidth - cropSize);
  }
  if (cropY + cropSize > imageHeight) {
    cropY = Math.max(0, imageHeight - cropSize);
  }

  const cropArea: CropRectangle = {
    x: Math.round(cropX),
    y: Math.round(cropY),
    width: Math.round(cropSize),
    height: Math.round(cropSize),
  };

  const maxSize = env.FACE_THUMBNAIL_SIZE;
  const quality = env.FACE_THUMBNAIL_QUALITY;

  const extension = outputPath.split(".").pop()?.toLowerCase();
  const outputFormat = extension === "webp" ? "webp" : "jpg";

  const pipeline = sharp(inputPath)
    .extract({
      left: cropArea.x,
      top: cropArea.y,
      width: cropArea.width,
      height: cropArea.height,
    })
    .resize({
      width: maxSize,
      height: maxSize,
      fit: "inside",
      withoutEnlargement: true,
    });

  if (outputFormat === "webp") {
    await pipeline.webp({ quality }).toFile(outputPath);
    return { outputPath };
  }

  await pipeline.jpeg({ quality }).toFile(outputPath);
  return { outputPath };
}

export async function resizeAndSaveCreatorThumbnail(params: {
  inputPath: string;
  outputPath: string;
  faceBox: number[];
  imageWidth: number;
  imageHeight: number;
  paddingScale?: number;
  size?: number;
  quality?: number;
}): Promise<{ outputPath: string; width: number; height: number }> {
  const {
    inputPath,
    outputPath,
    faceBox,
    imageWidth,
    imageHeight,
    paddingScale = 0.5,
    size = 128,
    quality = 75,
  } = params;

  const [x1, y1, x2, y2] = faceBox;
  const faceWidth = Math.max(0, x2 - x1);
  const faceHeight = Math.max(0, y2 - y1);
  const faceSize = Math.max(faceWidth, faceHeight);
  const paddedSize = faceSize * (1 + paddingScale * 2);

  const centerX = x1 + faceWidth / 2;
  const centerY = y1 + faceHeight / 2;

  const cropSize = Math.min(
    Math.max(paddedSize, 1),
    Math.min(imageWidth, imageHeight),
  );

  let cropX = centerX - cropSize / 2;
  let cropY = centerY - cropSize / 2;

  if (cropX < 0) cropX = 0;
  if (cropY < 0) cropY = 0;
  if (cropX + cropSize > imageWidth) {
    cropX = Math.max(0, imageWidth - cropSize);
  }
  if (cropY + cropSize > imageHeight) {
    cropY = Math.max(0, imageHeight - cropSize);
  }

  const cropArea: CropRectangle = {
    x: Math.round(cropX),
    y: Math.round(cropY),
    width: Math.round(cropSize),
    height: Math.round(cropSize),
  };

  await sharp(inputPath)
    .extract({
      left: cropArea.x,
      top: cropArea.y,
      width: cropArea.width,
      height: cropArea.height,
    })
    .resize({
      width: size,
      height: size,
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp({ quality })
    .toFile(outputPath);

  return { outputPath, width: size, height: size };
}

export async function processProfilePicture(params: {
  input: Buffer;
  format: "webp" | "jpg";
  maxSize: number;
  quality: number;
}): Promise<Buffer> {
  const { input, format, maxSize, quality } = params;

  let pipeline = sharp(input).rotate().resize({
    width: maxSize,
    height: maxSize,
    fit: "inside",
    withoutEnlargement: true,
  });

  pipeline =
    format === "webp" ? pipeline.webp({ quality }) : pipeline.jpeg({ quality });

  return pipeline.toBuffer();
}
