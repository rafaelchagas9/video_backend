import { createHash, randomBytes, randomUUID } from "crypto";
import { mkdir, rm, writeFile } from "fs/promises";
import { join, resolve } from "path";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import sharp from "sharp";
import { env } from "@/config/env";
import { db } from "@/config/drizzle";
import { videoFaceDetectionsTable } from "@/database/schema";
import { eq } from "drizzle-orm";
import { getFrameExtractionService } from "@/modules/frame-extraction";
import type {
  ArtworkEffect,
  ArtworkPalette,
  GeneratedArtworkAsset,
  GeneratedArtworkSet,
  NormalizedPoint,
  NormalizedRect,
  RasterArtworkVariant,
  StoredArtworkRequest,
} from "./artwork.types";

const VARIANT_SPECS: Record<
  RasterArtworkVariant,
  { width: number; height: number; effects: ArtworkEffect[] }
> = {
  card: { width: 640, height: 360, effects: [] },
  poster: { width: 400, height: 600, effects: ["scrim", "grain"] },
  square: { width: 400, height: 400, effects: ["scrim"] },
  hero: { width: 2560, height: 1097, effects: ["grain", "vignette"] },
};

const TITLE_RENDER_SCALE = 3;
const TITLE_MAX_CHARACTERS = 40;
// Two, not three. A three-line treatment at hero scale stops being a title and
// becomes a wall of text — it swallows the art it is supposed to sit on.
const TITLE_MAX_LINES = 2;
const TITLE_MAX_WIDTH = 720;
const TITLE_MAX_HEIGHT = 360;

interface ArtworkTitleRender {
  buffer: Buffer;
  width: number;
  height: number;
  lines: string[];
}

let titleFontsLoaded = false;

/**
 * Register the configured title face and its fallback.
 *
 * Both the family names and the files are configuration, because the treatment
 * has to agree with whatever pairing the clients ship — a baked PNG in the
 * wrong family is worse than no baked PNG at all.
 */
function ensureTitleFonts(): void {
  if (titleFontsLoaded) return;
  const display = GlobalFonts.registerFromPath(
    resolve(env.ARTWORK_TITLE_FONT_PATH),
    env.ARTWORK_TITLE_FONT_FAMILY,
  );
  const fallback = GlobalFonts.registerFromPath(
    resolve(env.ARTWORK_TITLE_FALLBACK_FONT_PATH),
    env.ARTWORK_TITLE_FALLBACK_FONT_FAMILY,
  );
  if (!display || !fallback) {
    throw new Error("Artwork title fonts could not be loaded");
  }
  titleFontsLoaded = true;
}

function titleCharacterCount(title: string): number {
  return Array.from(title).length;
}

export function isArtworkTitleEligible(title: string): boolean {
  const normalized = title.trim().replace(/\s+/g, " ");
  return normalized.length > 0 && titleCharacterCount(normalized) <= TITLE_MAX_CHARACTERS;
}

function titleLineCandidates(words: string[], lineCount: number): string[][] {
  if (lineCount === 1) return [[words.join(" ")]];
  const candidates: string[][] = [];
  const visit = (lines: string[], start: number): void => {
    const remainingLines = lineCount - lines.length;
    if (remainingLines === 1) {
      candidates.push([...lines, words.slice(start).join(" ")]);
      return;
    }
    const lastBreak = words.length - remainingLines + 1;
    for (let end = start + 1; end <= lastBreak; end += 1) {
      visit([...lines, words.slice(start, end).join(" ")], end);
    }
  };
  visit([], 0);
  return candidates;
}

function titleTracking(fontSize: number): number {
  const progress = Math.min(1, Math.max(0, (fontSize - 48) / 132));
  return -fontSize * (0.012 + progress * 0.024);
}

export async function renderArtworkTitle(title: string): Promise<ArtworkTitleRender | null> {
  const normalized = title.trim().replace(/\s+/g, " ");
  if (!isArtworkTitleEligible(normalized)) return null;
  ensureTitleFonts();

  const words = normalized.split(" ");
  const measuringCanvas = createCanvas(1, 1);
  const measuringContext = measuringCanvas.getContext("2d");
  measuringContext.fontKerning = "normal";
  measuringContext.textRendering = "optimizeLegibility";

  let selected: {
    lines: string[];
    fontSize: number;
    lineHeight: number;
    ascent: number;
    descent: number;
  } | null = null;

  for (let fontSize = 180; fontSize >= 42 && !selected; fontSize -= 2) {
    const scaledFontSize = fontSize * TITLE_RENDER_SCALE;
    measuringContext.font = `${scaledFontSize}px "${env.ARTWORK_TITLE_FONT_FAMILY}", "${env.ARTWORK_TITLE_FALLBACK_FONT_FAMILY}"`;
    measuringContext.letterSpacing = `${titleTracking(fontSize) * TITLE_RENDER_SCALE}px`;
    const lineHeight = fontSize * 0.92 * TITLE_RENDER_SCALE;

    for (let lineCount = 1; lineCount <= Math.min(TITLE_MAX_LINES, words.length); lineCount += 1) {
      const fitting = titleLineCandidates(words, lineCount)
        .map((lines) => {
          const metrics = lines.map((line) => measuringContext.measureText(line));
          const widths = metrics.map((metric) => metric.width);
          const ascent = Math.max(...metrics.map((metric) => metric.actualBoundingBoxAscent));
          const descent = Math.max(...metrics.map((metric) => metric.actualBoundingBoxDescent));
          const height = ascent + descent + lineHeight * (lines.length - 1);
          const meanWidth = widths.reduce((sum, width) => sum + width, 0) / widths.length;
          const raggedness = widths.reduce((sum, width) => sum + (width - meanWidth) ** 2, 0);
          const lastLineWords = lines.at(-1)?.split(" ").length ?? 0;
          return {
            lines,
            widths,
            ascent,
            descent,
            height,
            score: raggedness + (lineCount > 1 && lastLineWords === 1 ? scaledFontSize ** 2 : 0),
          };
        })
        .filter(
          (candidate) =>
            Math.max(...candidate.widths) <= TITLE_MAX_WIDTH * TITLE_RENDER_SCALE &&
            candidate.height <= TITLE_MAX_HEIGHT * TITLE_RENDER_SCALE,
        )
        .sort((a, b) => a.score - b.score);
      const best = fitting[0];
      if (best) {
        selected = {
          lines: best.lines,
          fontSize: scaledFontSize,
          lineHeight,
          ascent: best.ascent,
          descent: best.descent,
        };
        break;
      }
    }
  }

  if (!selected) return null;

  const padding = selected.fontSize * 0.3;
  measuringContext.font = `${selected.fontSize}px "${env.ARTWORK_TITLE_FONT_FAMILY}", "${env.ARTWORK_TITLE_FALLBACK_FONT_FAMILY}"`;
  measuringContext.letterSpacing = `${titleTracking(selected.fontSize / TITLE_RENDER_SCALE) * TITLE_RENDER_SCALE}px`;
  const measuredWidth = Math.max(
    ...selected.lines.map((line) => measuringContext.measureText(line).width),
  );
  const canvas = createCanvas(
    Math.ceil(measuredWidth + padding * 2),
    Math.ceil(selected.ascent + selected.descent + selected.lineHeight * (selected.lines.length - 1) + padding * 2),
  );
  const context = canvas.getContext("2d");
  context.font = measuringContext.font;
  context.fontKerning = "normal";
  context.letterSpacing = measuringContext.letterSpacing;
  context.textBaseline = "alphabetic";
  context.textRendering = "optimizeLegibility";
  context.fillStyle = "#ffffff";
  selected.lines.forEach((line, index) => {
    context.fillText(line, padding, padding + selected.ascent + index * selected.lineHeight);
  });

  const { data, info } = await sharp(canvas.toBuffer("image/png"))
    .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toBuffer({ resolveWithObject: true });
  return { buffer: data, width: info.width, height: info.height, lines: selected.lines };
}

interface FaceSignal extends NormalizedRect {
  timestamp: number;
  confidence: number;
}

interface FrameAnalysis {
  score: number;
  focalPoint: NormalizedPoint;
  faces: NormalizedRect[];
}

interface RawImage {
  data: Buffer;
  width: number;
  height: number;
  channels: number;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const frameExtractionService = getFrameExtractionService();

function srgbToLinear(value: number): number {
  const normalized = value / 255;
  return normalized <= 0.04045
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

function rgbToOklch(r: number, g: number, b: number) {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);
  const l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
  const m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
  const s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;
  const lRoot = Math.cbrt(l);
  const mRoot = Math.cbrt(m);
  const sRoot = Math.cbrt(s);
  const lightness = 0.2104542553 * lRoot + 0.793617785 * mRoot - 0.0040720468 * sRoot;
  const a = 1.9779984951 * lRoot - 2.428592205 * mRoot + 0.4505937099 * sRoot;
  const yellowBlue = 0.0259040371 * lRoot + 0.7827717662 * mRoot - 0.808675766 * sRoot;
  const chroma = Math.sqrt(a * a + yellowBlue * yellowBlue);
  const hue = (Math.atan2(yellowBlue, a) * 180) / Math.PI;
  return {
    l: Number(lightness.toFixed(5)),
    c: Number(chroma.toFixed(5)),
    h: Number(((hue + 360) % 360).toFixed(3)),
  };
}

function rgbHex(r: number, g: number, b: number): string {
  return `#${[r, g, b]
    .map((value) => Math.round(value).toString(16).padStart(2, "0"))
    .join("")}`;
}

async function rawImage(input: string | Buffer, width = 96, height = 54): Promise<RawImage> {
  const { data, info } = await sharp(input)
    .rotate()
    .resize(width, height, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

function pixelLuma(data: Buffer, offset: number): number {
  return (
    0.2126 * srgbToLinear(data[offset] ?? 0) +
    0.7152 * srgbToLinear(data[offset + 1] ?? 0) +
    0.0722 * srgbToLinear(data[offset + 2] ?? 0)
  );
}

function rectOverlap(a: NormalizedRect, b: NormalizedRect): number {
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return width * height;
}

function findSafeArea(raw: RawImage, faces: NormalizedRect[]): NormalizedRect | null {
  const candidates: NormalizedRect[] = [
    { x: 0.04, y: 0.12, width: 0.42, height: 0.58 },
    { x: 0.54, y: 0.12, width: 0.42, height: 0.58 },
    { x: 0.06, y: 0.62, width: 0.88, height: 0.32 },
    { x: 0.08, y: 0.08, width: 0.84, height: 0.26 },
  ];

  let best: { rect: NormalizedRect; score: number } | null = null;
  for (const rect of candidates) {
    const faceOverlap = faces.reduce((sum, face) => sum + rectOverlap(rect, face), 0);
    if (faceOverlap > 0.005) continue;

    const startX = Math.floor(rect.x * raw.width);
    const endX = Math.ceil((rect.x + rect.width) * raw.width);
    const startY = Math.floor(rect.y * raw.height);
    const endY = Math.ceil((rect.y + rect.height) * raw.height);
    const values: number[] = [];
    for (let y = startY; y < endY; y += 1) {
      for (let x = startX; x < endX; x += 1) {
        values.push(pixelLuma(raw.data, (y * raw.width + x) * raw.channels));
      }
    }
    const mean = values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
    const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, values.length);
    const score = variance - rect.width * rect.height * 0.01;
    if (!best || score < best.score) best = { rect, score };
  }
  return best?.rect ?? null;
}

function findSalience(raw: RawImage): NormalizedPoint {
  const columns = 6;
  const rows = 4;
  let best = { x: 0.5, y: 0.5, score: -1 };
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const values: number[] = [];
      const startX = Math.floor((column / columns) * raw.width);
      const endX = Math.ceil(((column + 1) / columns) * raw.width);
      const startY = Math.floor((row / rows) * raw.height);
      const endY = Math.ceil(((row + 1) / rows) * raw.height);
      for (let y = startY; y < endY; y += 1) {
        for (let x = startX; x < endX; x += 1) {
          values.push(pixelLuma(raw.data, (y * raw.width + x) * raw.channels));
        }
      }
      const mean = values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
      const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, values.length);
      if (variance > best.score) {
        best = {
          x: (column + 0.5) / columns,
          y: (row + 0.5) / rows,
          score: variance,
        };
      }
    }
  }
  return { x: best.x, y: best.y };
}

async function analyzeFrame(path: string, faces: FaceSignal[]): Promise<FrameAnalysis> {
  const raw = await rawImage(path);
  const lumas: number[] = [];
  let edgeEnergy = 0;
  let colorEnergy = 0;
  for (let y = 0; y < raw.height; y += 1) {
    for (let x = 0; x < raw.width; x += 1) {
      const offset = (y * raw.width + x) * raw.channels;
      const luma = pixelLuma(raw.data, offset);
      lumas.push(luma);
      if (x > 0) {
        edgeEnergy += Math.abs(luma - lumas[lumas.length - 2]);
      }
      const r = raw.data[offset] ?? 0;
      const g = raw.data[offset + 1] ?? 0;
      const b = raw.data[offset + 2] ?? 0;
      colorEnergy += (Math.abs(r - g) + Math.abs(g - b) + Math.abs(b - r)) / (255 * 3);
    }
  }
  const mean = lumas.reduce((sum, value) => sum + value, 0) / lumas.length;
  const variance = lumas.reduce((sum, value) => sum + (value - mean) ** 2, 0) / lumas.length;
  const usable = mean > 0.025 && variance > 0.0005;
  const bestFace = [...faces].sort(
    (a, b) => b.confidence * b.width * b.height - a.confidence * a.width * a.height,
  )[0];
  const faceBonus = bestFace
    ? bestFace.confidence * (bestFace.width * bestFace.height >= 0.04 && bestFace.width * bestFace.height <= 0.35 ? 0.35 : 0.12)
    : 0;
  return {
    score: usable
      ? variance * 5 + edgeEnergy / lumas.length + colorEnergy / lumas.length + faceBonus
      : -1,
    focalPoint: bestFace
      ? { x: clamp01(bestFace.x + bestFace.width / 2), y: clamp01(bestFace.y + bestFace.height / 2) }
      : findSalience(raw),
    faces: faces.map(({ x, y, width, height }) => ({ x, y, width, height })),
  };
}

/* ── Letterbox / pillarbox trim ───────────────────────────────────────────
   Trailers are routinely 2.39:1 mastered into a 16:9 container, so the frame
   we extract has black bands baked into it. Cropping a 2:3 poster out of that
   takes a full-height column and the bands come with it, which is why a poster
   ends up as a 16:9 pillar floating in black.

   So the bands have to come off *before* any variant geometry is computed.
   Detection is deliberately conservative: a row only counts as a band if its
   brightest pixel is still essentially black, bands are capped at a third of
   the dimension, and the whole result is discarded unless it keeps most of the
   frame. A dark-but-real frame must survive untouched — this library is full
   of them, and over-trimming is far worse than not trimming.
   ─────────────────────────────────────────────────────────────────────────── */

export interface PixelBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Brightest linear luma a row/column may contain and still count as a bar. */
const BAR_MAX_LUMA = 0.004;
/** Bands below this fraction of the dimension are quantisation noise, not bars. */
const BAR_MIN_FRACTION = 0.015;
/** No single band may remove more than this much of a dimension. */
const BAR_MAX_FRACTION = 0.34;
/** The trimmed frame must retain at least this much of each dimension. */
const BAR_MIN_REMAINING = 0.5;
/** How unequal two opposing bands may be before we stop believing them. */
const BAR_SYMMETRY_TOLERANCE = 0.25;

/**
 * Count leading and trailing all-dark bands along one axis.
 *
 * Symmetry is the load-bearing rule. Bars are produced by padding a scaled
 * image into a differently-shaped frame, so they are always centred — whereas a
 * dark *region* of an actual photograph sits wherever the composition put it.
 * Without this check, a genuinely dark frame gets cropped into a small bright
 * patch, which is much worse than leaving the bars on.
 */
function countBars(peaks: number[]): { lead: number; trail: number } {
  let lead = 0;
  while (lead < peaks.length && (peaks[lead] ?? 1) <= BAR_MAX_LUMA) lead += 1;
  // A fully black frame has no content to keep; treat it as untrimmable.
  if (lead === peaks.length) return { lead: 0, trail: 0 };

  let trail = 0;
  while (trail < peaks.length - lead && (peaks[peaks.length - 1 - trail] ?? 1) <= BAR_MAX_LUMA) trail += 1;

  const larger = Math.max(lead, trail);
  const minimum = peaks.length * BAR_MIN_FRACTION;
  if (larger < minimum) return { lead: 0, trail: 0 };
  // One sampled pixel of slack, so an odd number of padding rows still passes.
  if (larger - Math.min(lead, trail) > Math.max(1, larger * BAR_SYMMETRY_TOLERANCE)) {
    return { lead: 0, trail: 0 };
  }

  const limit = Math.floor(peaks.length * BAR_MAX_FRACTION);
  return { lead: Math.min(lead, limit), trail: Math.min(trail, limit) };
}

/**
 * The frame's real content box, in source pixels.
 *
 * Returns the full frame when nothing convincing is found, so callers can use
 * the result unconditionally.
 */
export async function detectContentBox(
  input: string | Buffer,
  sourceWidth: number,
  sourceHeight: number,
): Promise<PixelBox> {
  const full: PixelBox = { left: 0, top: 0, width: sourceWidth, height: sourceHeight };
  if (sourceWidth <= 0 || sourceHeight <= 0) return full;

  // Sampled at a fixed width with the aspect preserved, so band *positions*
  // stay proportional and a wide frame doesn't get squashed into a lie.
  const sampleWidth = 160;
  const sampleHeight = Math.max(2, Math.round((sampleWidth * sourceHeight) / sourceWidth));
  const raw = await rawImage(input, sampleWidth, sampleHeight);

  // Peak rather than mean luma: one bright pixel means the row is content, and
  // a mean would happily average a dim shot down into "bar" territory.
  const rowPeaks: number[] = [];
  const columnPeaks: number[] = new Array<number>(raw.width).fill(0);
  for (let y = 0; y < raw.height; y += 1) {
    let rowPeak = 0;
    for (let x = 0; x < raw.width; x += 1) {
      const luma = pixelLuma(raw.data, (y * raw.width + x) * raw.channels);
      if (luma > rowPeak) rowPeak = luma;
      if (luma > (columnPeaks[x] ?? 0)) columnPeaks[x] = luma;
    }
    rowPeaks.push(rowPeak);
  }

  const vertical = countBars(rowPeaks);
  const horizontal = countBars(columnPeaks);
  if (vertical.lead + vertical.trail + horizontal.lead + horizontal.trail === 0) return full;

  const scaleX = sourceWidth / raw.width;
  const scaleY = sourceHeight / raw.height;
  const left = Math.round(horizontal.lead * scaleX);
  const top = Math.round(vertical.lead * scaleY);
  const width = sourceWidth - left - Math.round(horizontal.trail * scaleX);
  const height = sourceHeight - top - Math.round(vertical.trail * scaleY);

  if (width < sourceWidth * BAR_MIN_REMAINING || height < sourceHeight * BAR_MIN_REMAINING) return full;
  return { left, top, width, height };
}

export function calculateArtworkCrop(params: {
  sourceWidth: number;
  sourceHeight: number;
  targetWidth: number;
  targetHeight: number;
  focalPoint: NormalizedPoint;
  poster?: boolean;
}): { pixels: { left: number; top: number; width: number; height: number }; normalized: NormalizedRect } {
  const { sourceWidth, sourceHeight, targetWidth, targetHeight, focalPoint, poster = false } = params;
  const targetAspect = targetWidth / targetHeight;
  const sourceAspect = sourceWidth / sourceHeight;
  let cropWidth = sourceWidth;
  let cropHeight = sourceHeight;
  if (sourceAspect > targetAspect) cropWidth = Math.round(sourceHeight * targetAspect);
  else cropHeight = Math.round(sourceWidth / targetAspect);

  const desiredFocalY = poster ? 1 / 3 : 0.5;
  const left = Math.round(
    Math.min(sourceWidth - cropWidth, Math.max(0, focalPoint.x * sourceWidth - cropWidth / 2)),
  );
  const top = Math.round(
    Math.min(sourceHeight - cropHeight, Math.max(0, focalPoint.y * sourceHeight - cropHeight * desiredFocalY)),
  );
  return {
    pixels: { left, top, width: cropWidth, height: cropHeight },
    normalized: {
      x: left / sourceWidth,
      y: top / sourceHeight,
      width: cropWidth / sourceWidth,
      height: cropHeight / sourceHeight,
    },
  };
}

function mapPointToCrop(point: NormalizedPoint, crop: NormalizedRect): NormalizedPoint {
  return {
    x: clamp01((point.x - crop.x) / crop.width),
    y: clamp01((point.y - crop.y) / crop.height),
  };
}

function mapFacesToCrop(faces: NormalizedRect[], crop: NormalizedRect): NormalizedRect[] {
  return faces
    .map((face) => {
      const x1 = clamp01((face.x - crop.x) / crop.width);
      const y1 = clamp01((face.y - crop.y) / crop.height);
      const x2 = clamp01((face.x + face.width - crop.x) / crop.width);
      const y2 = clamp01((face.y + face.height - crop.y) / crop.height);
      return { x: x1, y: y1, width: Math.max(0, x2 - x1), height: Math.max(0, y2 - y1) };
    })
    .filter((face) => face.width * face.height > 0.001);
}

function scrimSvg(width: number, height: number): Buffer {
  return Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="52%" stop-color="#000" stop-opacity="0"/><stop offset="78%" stop-color="#000" stop-opacity="0.18"/><stop offset="100%" stop-color="#000" stop-opacity="0.58"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/></svg>`);
}

function vignetteSvg(width: number, height: number): Buffer {
  return Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><defs><radialGradient id="v"><stop offset="68%" stop-color="#000" stop-opacity="0"/><stop offset="100%" stop-color="#000" stop-opacity="0.22"/></radialGradient></defs><rect width="100%" height="100%" fill="url(#v)"/></svg>`);
}

function grainLayer(width: number, height: number) {
  const noise = randomBytes(width * height);
  const rgba = Buffer.allocUnsafe(width * height * 4);
  for (let index = 0; index < noise.length; index += 1) {
    const value = noise[index] ?? 128;
    const offset = index * 4;
    rgba[offset] = value;
    rgba[offset + 1] = value;
    rgba[offset + 2] = value;
    rgba[offset + 3] = 9;
  }
  return { input: rgba, raw: { width, height, channels: 4 as const }, blend: "overlay" as const };
}

async function analyzeOutput(buffer: Buffer, faces: NormalizedRect[]) {
  const raw = await rawImage(buffer, 96, 54);
  let sum = 0;
  let count = 0;
  const startY = Math.floor(raw.height * (2 / 3));
  for (let y = startY; y < raw.height; y += 1) {
    for (let x = 0; x < raw.width; x += 1) {
      sum += pixelLuma(raw.data, (y * raw.width + x) * raw.channels);
      count += 1;
    }
  }
  return {
    bottomLuma: Number((sum / Math.max(1, count)).toFixed(5)),
    safeArea: findSafeArea(raw, faces),
  };
}

export async function extractArtworkPalette(buffer: Buffer): Promise<ArtworkPalette> {
  const raw = await rawImage(buffer, 64, 64);
  const buckets = new Map<string, { count: number; r: number; g: number; b: number }>();
  let red = 0;
  let green = 0;
  let blue = 0;
  const pixels = raw.width * raw.height;
  for (let offset = 0; offset < raw.data.length; offset += raw.channels) {
    const r = raw.data[offset] ?? 0;
    const g = raw.data[offset + 1] ?? 0;
    const b = raw.data[offset + 2] ?? 0;
    red += r;
    green += g;
    blue += b;
    const qr = Math.min(255, Math.round(r / 32) * 32);
    const qg = Math.min(255, Math.round(g / 32) * 32);
    const qb = Math.min(255, Math.round(b / 32) * 32);
    const key = `${qr},${qg},${qb}`;
    const bucket = buckets.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
    bucket.count += 1;
    bucket.r += r;
    bucket.g += g;
    bucket.b += b;
    buckets.set(key, bucket);
  }
  const swatches = [...buckets.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)
    .map((bucket) => rgbHex(bucket.r / bucket.count, bucket.g / bucket.count, bucket.b / bucket.count));
  const mean = { r: red / pixels, g: green / pixels, b: blue / pixels };
  const meanOklch = rgbToOklch(mean.r, mean.g, mean.b);
  return {
    dominant: swatches[0] ?? rgbHex(mean.r, mean.g, mean.b),
    swatches,
    mean_oklch: meanOklch,
    is_neutral: meanOklch.c < 0.03,
  };
}

async function faceSignals(videoId: number): Promise<FaceSignal[]> {
  const rows = await db
    .select({
      timestamp: videoFaceDetectionsTable.timestampSeconds,
      x1: videoFaceDetectionsTable.bboxX1,
      y1: videoFaceDetectionsTable.bboxY1,
      x2: videoFaceDetectionsTable.bboxX2,
      y2: videoFaceDetectionsTable.bboxY2,
      confidence: videoFaceDetectionsTable.detScore,
    })
    .from(videoFaceDetectionsTable)
    .where(eq(videoFaceDetectionsTable.videoId, videoId));
  return rows.map((row) => ({
    timestamp: row.timestamp,
    x: row.x1,
    y: row.y1,
    width: Math.max(0, row.x2 - row.x1),
    height: Math.max(0, row.y2 - row.y1),
    confidence: row.confidence,
  }));
}

async function selectSourceFrame(params: {
  videoId: number;
  videoPath: string;
  duration: number;
  timestamp?: number;
  workDir: string;
}) {
  const { videoId, videoPath, duration, timestamp, workDir } = params;
  const faces = await faceSignals(videoId);
  const minTimestamp = Math.max(0, duration * 0.03);
  const maxTimestamp = Math.max(minTimestamp, duration * 0.97);
  const preferredFace = [...faces]
    .filter((face) => {
      const area = face.width * face.height;
      return face.timestamp >= minTimestamp && face.timestamp <= maxTimestamp && area >= 0.04 && area <= 0.35;
    })
    .sort((a, b) => b.confidence - a.confidence)[0];
  const candidates = timestamp !== undefined
    ? [Math.min(maxTimestamp, Math.max(minTimestamp, timestamp))]
    : [preferredFace?.timestamp, ...[0.15, 0.35, 0.55, 0.75].map((position) => duration * position)]
        .filter((value): value is number => value !== undefined)
        .filter((value, index, values) => values.findIndex((other) => Math.abs(other - value) < 0.5) === index);

  let best: { path: string; timestamp: number; analysis: FrameAnalysis } | null = null;
  for (const candidate of candidates) {
    const path = await frameExtractionService.extractFrame({
      videoPath,
      timestampSeconds: candidate,
      outputDir: workDir,
      outputFormat: "jpg",
      quality: 90,
    });
    const nearbyFaces = faces.filter((face) => Math.abs(face.timestamp - candidate) <= 1);
    const analysis = await analyzeFrame(path, nearbyFaces);
    if (!best || analysis.score > best.analysis.score) best = { path, timestamp: candidate, analysis };
  }
  if (!best) throw new Error("No usable source frame could be extracted");
  return best;
}

async function renderVariant(params: {
  videoId: number;
  sourcePath: string;
  sourceTimestamp: number;
  sourceWidth: number;
  sourceHeight: number;
  focalPoint: NormalizedPoint;
  faces: NormalizedRect[];
  variant: RasterArtworkVariant;
  effects?: ArtworkEffect[];
  /** Frame content minus any letterbox/pillarbox bands. Defaults to the frame. */
  contentBox?: PixelBox;
}): Promise<{ asset: GeneratedArtworkAsset; buffer: Buffer }> {
  const spec = VARIANT_SPECS[params.variant];
  const content = params.contentBox ?? {
    left: 0,
    top: 0,
    width: params.sourceWidth,
    height: params.sourceHeight,
  };
  // Geometry is computed inside the content box so bands can never enter a
  // variant, then translated back into frame coordinates for the extract and
  // for the crop rect we publish — that rect stays relative to the real frame.
  const crop = calculateArtworkCrop({
    sourceWidth: content.width,
    sourceHeight: content.height,
    targetWidth: spec.width,
    targetHeight: spec.height,
    focalPoint: mapPointToCrop(params.focalPoint, {
      x: content.left / params.sourceWidth,
      y: content.top / params.sourceHeight,
      width: content.width / params.sourceWidth,
      height: content.height / params.sourceHeight,
    }),
    poster: params.variant === "poster",
  });
  crop.pixels.left += content.left;
  crop.pixels.top += content.top;
  crop.normalized = {
    x: crop.pixels.left / params.sourceWidth,
    y: crop.pixels.top / params.sourceHeight,
    width: crop.pixels.width / params.sourceWidth,
    height: crop.pixels.height / params.sourceHeight,
  };
  const scale = Math.min(1, spec.width / crop.pixels.width, spec.height / crop.pixels.height);
  const width = Math.max(1, Math.round(crop.pixels.width * scale));
  const height = Math.max(1, Math.round(crop.pixels.height * scale));
  const effects = (params.effects ?? spec.effects).filter((effect) => effect !== "title");
  let pipeline = sharp(params.sourcePath)
    .rotate()
    .extract(crop.pixels)
    .resize(width, height, { fit: "fill", withoutEnlargement: true });
  const overlays = [];
  if (effects.includes("scrim")) overlays.push({ input: scrimSvg(width, height), blend: "over" as const });
  if (effects.includes("grain")) overlays.push(grainLayer(width, height));
  if (effects.includes("vignette")) overlays.push({ input: vignetteSvg(width, height), blend: "over" as const });
  if (overlays.length > 0) pipeline = pipeline.composite(overlays);
  const buffer = await pipeline.webp({ quality: env.ARTWORK_QUALITY, smartSubsample: true }).toBuffer();
  const hash = createHash("sha256").update(buffer).digest("hex").slice(0, 16);
  const directory = join(env.ARTWORK_DIR, `video-${params.videoId}`);
  await mkdir(directory, { recursive: true });
  const filePath = join(directory, `${params.variant}-${hash}.webp`);
  await writeFile(filePath, buffer);
  const mappedFaces = mapFacesToCrop(params.faces, crop.normalized);
  const outputAnalysis = await analyzeOutput(buffer, mappedFaces);
  return {
    buffer,
    asset: {
      videoId: params.videoId,
      variant: params.variant,
      contentHash: hash,
      filePath,
      fileSizeBytes: buffer.byteLength,
      width,
      height,
      sourceTimestampSeconds: params.sourceTimestamp,
      crop: crop.normalized,
      focalPoint: mapPointToCrop(params.focalPoint, crop.normalized),
      safeArea: outputAnalysis.safeArea,
      bottomLuma: outputAnalysis.bottomLuma,
      thumbhash: null,
      effects,
    },
  };
}

async function renderTitleVariant(params: {
  videoId: number;
  title: string;
}): Promise<{ asset: GeneratedArtworkAsset; buffer: Buffer } | null> {
  const rendered = await renderArtworkTitle(params.title);
  if (!rendered) return null;
  const hash = createHash("sha256").update(rendered.buffer).digest("hex").slice(0, 16);
  const directory = join(env.ARTWORK_DIR, `video-${params.videoId}`);
  await mkdir(directory, { recursive: true });
  const filePath = join(directory, `title-${hash}.png`);
  await writeFile(filePath, rendered.buffer);
  return {
    buffer: rendered.buffer,
    asset: {
      videoId: params.videoId,
      variant: "title",
      contentHash: hash,
      filePath,
      fileSizeBytes: rendered.buffer.byteLength,
      width: rendered.width,
      height: rendered.height,
      sourceTimestampSeconds: null,
      crop: null,
      focalPoint: null,
      safeArea: null,
      bottomLuma: null,
      thumbhash: null,
      effects: ["title"],
    },
  };
}

export async function generateArtworkFiles(params: {
  video: {
    id: number;
    file_path: string;
    file_name: string;
    title: string | null;
    duration_seconds: number | null;
    width: number | null;
    height: number | null;
  };
  request: StoredArtworkRequest;
}): Promise<GeneratedArtworkSet> {
  const rendered: Array<{ asset: GeneratedArtworkAsset; buffer: Buffer }> = [];
  const wantsTitle = params.request.variants.includes("title");
  const displayTitle = params.video.title?.trim() || params.video.file_name.replace(/\.[^.]+$/, "");

  const rasterVariants = params.request.variants.filter(
    (variant): variant is RasterArtworkVariant => variant !== "title",
  );
  if (rasterVariants.length === 0) {
    if (!wantsTitle) return { assets: [], palette: null };
    const title = await renderTitleVariant({ videoId: params.video.id, title: displayTitle });
    if (title) rendered.push(title);
    return { assets: rendered.map((item) => item.asset), palette: null };
  }

  const duration = params.video.duration_seconds;
  if (!duration || duration <= 0) throw new Error("Video duration is unavailable");
  const workDir = join(env.ARTWORK_DIR, ".work", `video-${params.video.id}-${randomUUID()}`);
  await mkdir(workDir, { recursive: true });
  try {
    const selected = await selectSourceFrame({
      videoId: params.video.id,
      videoPath: params.video.file_path,
      duration,
      timestamp: params.request.timestamp_seconds,
      workDir,
    });
    const metadata = await sharp(selected.path).metadata();
    const sourceWidth = metadata.width ?? params.video.width;
    const sourceHeight = metadata.height ?? params.video.height;
    if (!sourceWidth || !sourceHeight) throw new Error("Source frame dimensions are unavailable");

    // Detected once per frame, not per variant — every variant has to be cut
    // from the same content box or they stop agreeing with each other.
    const contentBox = await detectContentBox(selected.path, sourceWidth, sourceHeight);

    for (const variant of rasterVariants) {
      rendered.push(
        await renderVariant({
          videoId: params.video.id,
          sourcePath: selected.path,
          sourceTimestamp: selected.timestamp,
          sourceWidth,
          sourceHeight,
          focalPoint: selected.analysis.focalPoint,
          faces: selected.analysis.faces,
          variant,
          effects: params.request.effects,
          contentBox,
        }),
      );
    }
    if (wantsTitle) {
      const title = await renderTitleVariant({ videoId: params.video.id, title: displayTitle });
      if (title) rendered.push(title);
    }
    const card = rendered.find((item) => item.asset.variant === "card");
    return {
      assets: rendered.map((item) => item.asset),
      palette: card ? await extractArtworkPalette(card.buffer) : null,
    };
  } catch (error) {
    await Promise.all(rendered.map((item) => rm(item.asset.filePath, { force: true })));
    throw error;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
