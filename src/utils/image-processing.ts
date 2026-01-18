import sharp from "sharp";

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
}): Promise<void> {
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

  await sharp(inputPath)
    .extract({
      left: cropArea.x,
      top: cropArea.y,
      width: cropArea.width,
      height: cropArea.height,
    })
    .jpeg({ quality: 90 })
    .toFile(outputPath);
}
