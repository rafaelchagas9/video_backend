#!/usr/bin/env bun
import { open, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { z } from "zod";
import {
  validateCatalogResult,
  type HistoricalCatalogResult,
} from "@/modules/perceptual-duplicates/perceptual-catalog.schemas";
import {
  assessPerceptualMatch,
  PERCEPTUAL_ASSESSMENT_REVISION,
} from "@/modules/perceptual-duplicates/perceptual-relevance";

const catalogSchema = z
  .object({
    videos: z.record(
      z.string(),
      z
        .object({
          video: z
            .object({
              id: z.number().int().positive(),
              duration_seconds: z
                .number()
                .finite()
                .min(5)
                .max(24 * 60 * 60),
            })
            .strip(),
        })
        .strip()
    ),
  })
  .strip();

const savedResultSchema = z
  .object({
    result: z.unknown(),
  })
  .strip();

type ReplayPair = {
  video_ids: [number, number];
  classification: ReturnType<typeof assessPerceptualMatch>["classification"];
  group: ReturnType<typeof assessPerceptualMatch>["group"];
};

export type PerceptualRelevanceReplay = {
  version: 1;
  assessment_revision: typeof PERCEPTUAL_ASSESSMENT_REVISION;
  counts: {
    catalog_results: number;
    compared_pairs: number;
    raw_matches: number;
    unique_pairs: number;
    candidate_limited_pairs: number;
    truncated_results: number;
    groups: Record<ReplayPair["group"], number>;
    classifications: Record<ReplayPair["classification"], number>;
  };
  pairs: ReplayPair[];
};

type ReplayOptions = {
  cacheDir: string;
  outputPath?: string;
  help: boolean;
};

type PublishedResult = {
  result: HistoricalCatalogResult;
  publicationMtimeMs: number;
  videoId: number;
};

const RESULT_NAME = /^catalog-result-(\d+)\.json$/;
const HELP = `Usage: bun scripts/replay-perceptual-relevance.ts [options]

Read-only replay of the relevance policy over persisted catalogue JSON.

Options:
  --cache-dir <directory>  Cache containing catalog.json and catalog-result-*.json
                           (default: data/perceptual-duplicates-cache)
  --output <file>          Create a new JSON report outside the cache (default: stdout)
  --help                   Show this help
`;

export function parseReplayArguments(args: string[]): ReplayOptions {
  let cacheDir = resolve("data/perceptual-duplicates-cache");
  let outputPath: string | undefined;
  let help = false;
  const seen = new Set<string>();

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!;
    if (flag === "--help") {
      if (seen.has(flag)) throw new Error("Duplicate option: --help");
      seen.add(flag);
      help = true;
      continue;
    }
    if (flag !== "--cache-dir" && flag !== "--output") {
      throw new Error(`Unknown option: ${flag}`);
    }
    if (seen.has(flag)) throw new Error(`Duplicate option: ${flag}`);
    seen.add(flag);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${flag}`);
    }
    index += 1;
    if (flag === "--cache-dir") cacheDir = resolve(value);
    else outputPath = resolve(value);
  }

  if (help && args.length !== 1) {
    throw new Error("--help cannot be combined with other options");
  }
  return { cacheDir, outputPath, help };
}

function pairKey(videoA: number, videoB: number): string {
  return videoA < videoB ? `${videoA}:${videoB}` : `${videoB}:${videoA}`;
}

function emptyClassificationCounts(): PerceptualRelevanceReplay["counts"]["classifications"] {
  return {
    near_duplicate: 0,
    contained_clip: 0,
    partial_overlap: 0,
    similarity: 0,
    shared_fragment: 0,
    insufficient_evidence: 0,
  };
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function readPublishedResult(
  path: string,
  videoId: number,
  durations: Map<number, number>
): Promise<PublishedResult> {
  const handle = await open(path, "r");
  try {
    // Read content and publication time through the same opened inode. This
    // prevents a path replacement between separate read/stat operations from
    // pairing one result with another file's timestamp.
    const raw = await handle.readFile("utf8");
    const publication = await handle.stat();
    const saved = savedResultSchema.parse(JSON.parse(raw) as unknown);
    return {
      result: validateCatalogResult(saved.result, videoId, durations, true),
      publicationMtimeMs: publication.mtimeMs,
      videoId,
    };
  } finally {
    await handle.close();
  }
}

export async function replayPerceptualRelevance(
  cacheDirectory: string
): Promise<PerceptualRelevanceReplay> {
  const cacheDir = await realpath(resolve(cacheDirectory));
  const catalog = catalogSchema.parse(
    await readJson(resolve(cacheDir, "catalog.json"))
  );
  const durations = new Map<number, number>();
  for (const [key, record] of Object.entries(catalog.videos)) {
    if (key !== String(record.video.id) || durations.has(record.video.id)) {
      throw new Error("Invalid catalogue video identifier");
    }
    durations.set(record.video.id, record.video.duration_seconds);
  }

  const resultFiles = (
    await readdir(cacheDir, { withFileTypes: true })
  ).flatMap((entry) => {
    if (!entry.isFile()) return [];
    const match = RESULT_NAME.exec(entry.name);
    if (!match) return [];
    const videoId = Number(match[1]);
    return Number.isSafeInteger(videoId) && videoId > 0
      ? [{ name: entry.name, videoId }]
      : [];
  });

  const publishedResults = await Promise.all(
    resultFiles.map((file) =>
      readPublishedResult(resolve(cacheDir, file.name), file.videoId, durations)
    )
  );
  // A pair's most recently published valid snapshot wins. Owner ID is only a
  // deterministic tie-break for files with the same timestamp.
  publishedResults.sort(
    (left, right) =>
      right.publicationMtimeMs - left.publicationMtimeMs ||
      right.videoId - left.videoId
  );
  const results = publishedResults.map(({ result }) => result);

  const pairs: ReplayPair[] = [];
  const seenPairs = new Set<string>();
  for (const result of results) {
    for (const match of result.matches) {
      const key = pairKey(match.video_a, match.video_b);
      if (seenPairs.has(key)) continue;
      seenPairs.add(key);
      const durationA = durations.get(match.video_a);
      const durationB = durations.get(match.video_b);
      if (durationA === undefined || durationB === undefined) {
        throw new Error("Catalogue result references an unknown video");
      }
      const assessment = assessPerceptualMatch(match, durationA, durationB);
      pairs.push({
        video_ids: [match.video_a, match.video_b].sort(
          (left, right) => left - right
        ) as [number, number],
        classification: assessment.classification,
        group: assessment.group,
      });
    }
  }
  pairs.sort(
    (left, right) =>
      left.video_ids[0] - right.video_ids[0] ||
      left.video_ids[1] - right.video_ids[1]
  );

  const groups: PerceptualRelevanceReplay["counts"]["groups"] = {
    copies: 0,
    similarity: 0,
    suppressed: 0,
  };
  const classifications = emptyClassificationCounts();
  for (const pair of pairs) {
    groups[pair.group] += 1;
    classifications[pair.classification] += 1;
  }

  return {
    version: 1,
    assessment_revision: PERCEPTUAL_ASSESSMENT_REVISION,
    counts: {
      catalog_results: results.length,
      compared_pairs: results.reduce(
        (sum, result) => sum + result.compared_videos,
        0
      ),
      raw_matches: results.reduce(
        (sum, result) => sum + result.matches.length,
        0
      ),
      unique_pairs: pairs.length,
      candidate_limited_pairs: results.reduce(
        (sum, result) => sum + result.candidate_limited_pairs,
        0
      ),
      truncated_results: results.filter((result) => result.truncated_matches)
        .length,
      groups,
      classifications,
    },
    pairs,
  };
}

function isWithin(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return child === "" || (!child.startsWith(`..${sep}`) && !isAbsolute(child));
}

async function writeNewReport(
  cacheDirectory: string,
  outputPath: string,
  json: string
): Promise<void> {
  const [cacheDir, outputParent] = await Promise.all([
    realpath(resolve(cacheDirectory)),
    realpath(dirname(outputPath)),
  ]);
  const destination = join(outputParent, basename(outputPath));
  if (isWithin(cacheDir, destination)) {
    throw new Error(
      "Refusing to write a replay report inside the cache directory"
    );
  }
  await writeFile(destination, json, { encoding: "utf8", flag: "wx" });
}

async function main(): Promise<void> {
  const options = parseReplayArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  const report = await replayPerceptualRelevance(options.cacheDir);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (options.outputPath) {
    await writeNewReport(options.cacheDir, options.outputPath, json);
  } else {
    process.stdout.write(json);
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message =
      error instanceof Error ? error.message : "Unknown replay error";
    process.stderr.write(`Perceptual relevance replay failed: ${message}\n`);
    process.exitCode = 1;
  });
}
