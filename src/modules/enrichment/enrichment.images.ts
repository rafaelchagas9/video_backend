import sharp from "sharp";
import { BadRequestError } from "@/utils/errors";
import {
  downloadRemoteImage,
  probeRemoteImageSize,
} from "@/utils/remote-image-download";

const MAX_INLINE_BYTES = 20 * 1024 * 1024;
/** Stash scrapers return base64 data URLs rather than public HTTP image URLs. */
export function decodeStashImage(value: string): Buffer {
  const match =
    /^data:image\/(?:jpeg|jpg|png|webp|gif|avif);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(
      value
    );
  if (!match || match[1].length > Math.ceil(MAX_INLINE_BYTES / 3) * 4)
    throw new BadRequestError("Invalid or oversized Stash image");
  const bytes = Buffer.from(match[1], "base64");
  if (
    !bytes.length ||
    bytes.length > MAX_INLINE_BYTES ||
    bytes.toString("base64").replace(/=+$/, "") !== match[1].replace(/=+$/, "")
  )
    throw new BadRequestError("Invalid Stash image encoding");
  return bytes;
}
export async function loadEnrichmentImage(value: string): Promise<Buffer> {
  const bytes = value.startsWith("data:")
    ? decodeStashImage(value)
    : await downloadRemoteImage(value);
  try {
    await sharp(bytes, { limitInputPixels: 100_000_000 }).metadata();
  } catch {
    throw new BadRequestError("Unable to decode the proposed image");
  }
  return bytes;
}
export async function probeEnrichmentImage(value: string) {
  if (!value.startsWith("data:")) return probeRemoteImageSize(value);
  try {
    const metadata = await sharp(decodeStashImage(value), {
      limitInputPixels: 100_000_000,
    }).metadata();
    return metadata.width && metadata.height
      ? { width: metadata.width, height: metadata.height }
      : null;
  } catch {
    return null;
  }
}
