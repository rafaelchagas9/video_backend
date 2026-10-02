/**
 * Re-cut legacy single-sheet storyboards into 5×5 pages.
 *
 * New storyboards are rendered as pages (see storyboards.pages). Older ones are
 * one sheet that grows to ~100 MP on long videos, which clients can only show
 * blurry or by slow region decoding. This decodes each sheet once with FFmpeg
 * (`untile` → `tile=5x5`) without touching the source video, keeps the cue
 * timings from the old VTT, and swaps the row over only if it still points at
 * the sheet that was read, so a storyboard regenerated meanwhile is left alone.
 *
 * Dry run by default. Pass `--apply` to write pages and update rows.
 *
 *   bun scripts/paginate-storyboards.ts
 *   bun scripts/paginate-storyboards.ts --apply
 *   bun scripts/paginate-storyboards.ts --apply --limit 20 --concurrency 2
 *   bun scripts/paginate-storyboards.ts --apply --demo   # demo SQLite library
 *
 * In demo mode the old sheets are kept: the demo seed manifest references them.
 */

import { randomUUID } from "node:crypto";
import { readFile, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { and, eq } from "drizzle-orm";
import { env } from "@/config/env";
import {
  buildPagedStoryboardVtt,
  isPagedSpritePath,
  storyboardPagePaths,
  type StoryboardFormat,
} from "@/modules/storyboards/storyboards.pages";
import { paginateSheet } from "@/modules/storyboards/storyboards.ffmpeg";

const apply = process.argv.includes("--apply");
const demo = process.argv.includes("--demo");
const numberArgument = (name: string, fallback: number) => {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? fallback : Number(process.argv[index + 1]);
  if (!Number.isInteger(value) || value < 1)
    throw new Error(`${name} must be a positive integer`);
  return value;
};
const limit = numberArgument("--limit", Number.MAX_SAFE_INTEGER);
// A 16320×6000 sheet decodes to ~400 MB, so keep this low.
const concurrency = numberArgument("--concurrency", 2);

interface Row {
  id: number;
  videoId: number;
  spritePath: string;
  vttPath: string;
  tileWidth: number;
  tileHeight: number;
}

interface Swap {
  spritePath: string;
  vttPath: string;
  tileCount: number;
  spriteSizeBytes: number;
}

/** Storage differences between the Postgres library and the demo SQLite one. */
interface Library {
  rows(): Promise<Row[]>;
  /** Absolute path of a stored path. */
  file(path: string): string;
  /** Stored form of an absolute path. */
  stored(path: string): string;
  /** Replace the row only if it still holds `previous`; true when it did. */
  swap(row: Row, next: Swap): Promise<boolean>;
  keepsOldFiles: boolean;
}

async function postgresLibrary(): Promise<Library> {
  const { db } = await import("@/config/drizzle");
  const { storyboardsTable } = await import("@/database/schema");
  return {
    rows: () => db.select().from(storyboardsTable),
    file: (path) => path,
    stored: (path) => path,
    async swap(row, next) {
      const updated = await db
        .update(storyboardsTable)
        .set({ ...next, generatedAt: new Date() })
        .where(
          and(
            eq(storyboardsTable.id, row.id),
            eq(storyboardsTable.spritePath, row.spritePath)
          )
        )
        .returning({ id: storyboardsTable.id });
      return updated.length === 1;
    },
    keepsOldFiles: false,
  };
}

async function demoLibrary(): Promise<Library> {
  const { getDemoDatabase, demoSchema } = await import("@/database/demo");
  const table = demoSchema.demoStoryboardsTable;
  return {
    rows: async () =>
      getDemoDatabase()
        .select()
        .from(table)
        .all()
        .map((row) => ({ ...row, id: row.videoId })),
    file: (path) => resolve(process.cwd(), path),
    stored: (path) => relative(process.cwd(), path),
    async swap(row, next) {
      const updated = getDemoDatabase()
        .update(table)
        .set({ ...next, generatedAt: new Date().toISOString() })
        .where(
          and(
            eq(table.videoId, row.videoId),
            eq(table.spritePath, row.spritePath)
          )
        )
        .returning({ videoId: table.videoId })
        .all();
      return updated.length === 1;
    },
    keepsOldFiles: true,
  };
}

interface LegacyCue {
  start: number;
  end: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

function seconds(value: string): number {
  // Older VTTs could carry ".1000" when milliseconds rounded up; read those
  // as a whole second rather than rejecting the storyboard.
  const match = /^(?:(\d+):)?(\d{2}):(\d{2})(?:\.(\d{1,4}))?$/.exec(value);
  if (!match) throw new Error(`Bad VTT timestamp: ${value}`);
  const fraction = match[4] ?? "0";
  return (
    Number(match[1] ?? 0) * 3600 +
    Number(match[2]) * 60 +
    Number(match[3]) +
    Number(fraction.length > 3 ? fraction : fraction.padEnd(3, "0")) / 1000
  );
}

function parseLegacyVtt(text: string): LegacyCue[] {
  const cues: LegacyCue[] = [];
  for (const block of text.trim().split(/\r?\n\s*\r?\n/)) {
    const lines = block.split(/\r?\n/).map((line) => line.trim());
    const timing = lines.findIndex((line) => line.includes("-->"));
    if (timing === -1) continue;
    const [start, end] = lines[timing]!.split(/\s+-->\s+/);
    const target = /#xywh=(\d+),(\d+),(\d+),(\d+)$/.exec(
      lines[timing + 1] ?? ""
    );
    if (!start || !end || !target) continue;
    const [x, y, w, h] = target.slice(1).map(Number) as [
      number,
      number,
      number,
      number,
    ];
    cues.push({
      start: seconds(start),
      end: seconds(end.split(/\s+/)[0]!),
      x,
      y,
      w,
      h,
    });
  }
  return cues;
}

/**
 * The sheet's grid, provided the cues fill it row-major with uniform tiles;
 * that is what `untile` reads back. Anything else is reported and skipped.
 */
function sheetGrid(cues: LegacyCue[], row: Row) {
  const first = cues[0];
  if (!first) throw new Error("VTT has no cues");
  const { w, h } = first;
  const cols = Math.max(...cues.map((cue) => cue.x)) / w + 1;
  const rows = Math.max(...cues.map((cue) => cue.y)) / h + 1;
  cues.forEach((cue, index) => {
    if (
      cue.w !== w ||
      cue.h !== h ||
      cue.x !== (index % cols) * w ||
      cue.y !== Math.floor(index / cols) * h
    )
      throw new Error(`Cue ${index} is not on a row-major ${w}×${h} grid`);
  });
  if (w !== row.tileWidth || h !== row.tileHeight)
    console.warn(
      `  video ${row.videoId}: VTT tiles are ${w}×${h}, row says ${row.tileWidth}×${row.tileHeight}; using the VTT`
    );
  return { cols, rows, tileWidth: w, tileHeight: h };
}

type Outcome =
  | { kind: "paged"; pages: number; before: number; after: number; ms: number }
  | { kind: "planned"; pages: number; before: number }
  | { kind: "skipped"; reason: string };

async function paginate(library: Library, row: Row): Promise<Outcome> {
  const sheet = library.file(row.spritePath);
  const extension = extname(sheet).slice(1).toLowerCase();
  if (extension !== "webp" && extension !== "jpg")
    return { kind: "skipped", reason: `unsupported sheet format .${extension}` };
  const format = extension as StoryboardFormat;

  const cues = parseLegacyVtt(await readFile(library.file(row.vttPath), "utf8"));
  const grid = sheetGrid(cues, row);
  const before = (await stat(sheet)).size;
  const base = join(
    dirname(sheet),
    `storyboard_${row.videoId}_${Date.now()}_${randomUUID()}`
  );
  const pagePaths = storyboardPagePaths(base, format, cues.length);
  if (!apply) return { kind: "planned", pages: pagePaths.length, before };

  const started = Date.now();
  const vttPath = `${base}.vtt`;
  let swapped = false;
  try {
    await paginateSheet(
      {
        sheetPath: sheet,
        outputPaths: pagePaths,
        ...grid,
        tileCount: cues.length,
        format,
        // Pages are re-encoded from an already lossy sheet; don't lose more.
        quality: format === "webp" ? Math.max(env.STORYBOARD_QUALITY, 85) : 90,
      },
      env.FFMPEG_PATH
    );
    await writeFile(
      vttPath,
      buildPagedStoryboardVtt({
        videoId: row.videoId,
        vttPath,
        format,
        tileWidth: grid.tileWidth,
        tileHeight: grid.tileHeight,
        cues,
      }),
      "utf-8"
    );
    const sizes = await Promise.all(pagePaths.map((path) => stat(path)));
    const after = sizes.reduce((sum, file) => sum + file.size, 0);
    swapped = await library.swap(row, {
      spritePath: library.stored(pagePaths[0]!),
      vttPath: library.stored(vttPath),
      tileCount: cues.length,
      spriteSizeBytes: after,
    });
    if (!swapped)
      return { kind: "skipped", reason: "storyboard changed while paging" };
    if (!library.keepsOldFiles)
      await Promise.all(
        [sheet, library.file(row.vttPath)].map((path) =>
          unlink(path).catch(() => {})
        )
      );
    return {
      kind: "paged",
      pages: pagePaths.length,
      before,
      after,
      ms: Date.now() - started,
    };
  } finally {
    if (!swapped)
      await Promise.all(
        [...pagePaths, vttPath].map((path) => unlink(path).catch(() => {}))
      );
  }
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

async function main() {
  const library = demo ? await demoLibrary() : await postgresLibrary();
  const candidates = (await library.rows())
    .filter((row) => !isPagedSpritePath(row.spritePath))
    .sort((a, b) => a.videoId - b.videoId)
    .slice(0, limit);
  console.log(
    `${apply ? "Paging" : "Dry run:"} ${candidates.length} legacy storyboard(s) in the ${demo ? "demo" : "main"} library`
  );

  const totals = { paged: 0, skipped: 0, failed: 0, before: 0, after: 0 };
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < candidates.length) {
      const row = candidates[next++]!;
      const label = `[${++done}/${candidates.length}] video ${row.videoId} (${basename(row.spritePath)})`;
      try {
        const outcome = await paginate(library, row);
        if (outcome.kind === "paged") {
          totals.paged++;
          totals.before += outcome.before;
          totals.after += outcome.after;
          console.log(
            `${label}: ${outcome.pages} pages, ${mb(outcome.before)} → ${mb(outcome.after)} in ${(outcome.ms / 1000).toFixed(1)}s`
          );
        } else if (outcome.kind === "planned") {
          totals.before += outcome.before;
          console.log(`${label}: would write ${outcome.pages} pages`);
        } else {
          totals.skipped++;
          console.log(`${label}: skipped, ${outcome.reason}`);
        }
      } catch (error) {
        totals.failed++;
        console.error(
          `${label}: failed, ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));

  console.log(
    apply
      ? `Done: ${totals.paged} paged, ${totals.skipped} skipped, ${totals.failed} failed; ${mb(totals.before)} of sheets → ${mb(totals.after)} of pages`
      : `Dry run: ${mb(totals.before)} of sheets would be paged; pass --apply to write`
  );
  process.exit(totals.failed > 0 ? 1 : 0);
}

await main();
