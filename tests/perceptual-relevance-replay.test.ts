import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  CATALOG_REVISION,
  type PerceptualCatalogResult,
} from "@/modules/perceptual-duplicates/perceptual-catalog.schemas";
import {
  engineMatchSchema,
  intervalCoverage,
} from "@/modules/perceptual-duplicates/perceptual-duplicates.schemas";
import { assessPerceptualMatch } from "@/modules/perceptual-duplicates/perceptual-relevance";
import { replayPerceptualRelevance } from "../scripts/replay-perceptual-relevance";

const incidentSchema = z
  .object({
    version: z.literal(1),
    pairs: z.array(
      z
        .object({
          duration_a: z.number().finite().positive(),
          duration_b: z.number().finite().positive(),
          match: engineMatchSchema,
        })
        .strict()
    ),
  })
  .strict();

const fixturePath = new URL(
  "./fixtures/perceptual-relevance-incident.json",
  import.meta.url
);
const incident = incidentSchema.parse(await Bun.file(fixturePath).json());
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

function key(videoA: number, videoB: number): string {
  return [videoA, videoB].sort((left, right) => left - right).join(":");
}

function incidentAssessments() {
  return new Map(
    incident.pairs.map(({ duration_a, duration_b, match }) => [
      key(match.video_a, match.video_b),
      assessPerceptualMatch(match, duration_a, duration_b),
    ])
  );
}

async function makeIncidentCache(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "perceptual-replay-test-"));
  temporaryDirectories.push(directory);
  const videos = new Map<number, number>();
  for (const { duration_a, duration_b, match } of incident.pairs) {
    videos.set(match.video_a, duration_a);
    videos.set(match.video_b, duration_b);
  }
  await writeFile(
    join(directory, "catalog.json"),
    JSON.stringify({
      videos: Object.fromEntries(
        [...videos].map(([id, duration_seconds]) => [
          id,
          { video: { id, duration_seconds } },
        ])
      ),
    })
  );

  const bySource = new Map<number, typeof incident.pairs>();
  for (const pair of incident.pairs) {
    const sourceId = Math.max(pair.match.video_a, pair.match.video_b);
    const current = bySource.get(sourceId) ?? [];
    current.push(pair);
    bySource.set(sourceId, current);
  }
  await Promise.all(
    [...bySource].map(([sourceId, pairs]) => {
      const result: PerceptualCatalogResult = {
        version: 1,
        revision: CATALOG_REVISION,
        video_id: sourceId,
        compared_videos: pairs.length,
        skipped_references: 0,
        match_count: pairs.length,
        matches: pairs.map((pair) => pair.match),
        truncated_matches: false,
        candidate_limited_pairs: 0,
      };
      return writeFile(
        join(directory, `catalog-result-${sourceId}.json`),
        JSON.stringify({ result })
      );
    })
  );
  return directory;
}

async function runCli(args: string[]) {
  const child = Bun.spawn(
    [process.execPath, "scripts/replay-perceptual-relevance.ts", ...args],
    { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" }
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function cacheSnapshot(directory: string) {
  const names = (await readdir(directory)).sort();
  return Promise.all(
    names.map(async (name) => {
      const metadata = await stat(join(directory, name));
      return {
        name,
        size: metadata.size,
        mtimeMs: metadata.mtimeMs,
      };
    })
  );
}

describe("perceptual relevance incident replay", () => {
  test("keeps the confirmed pair as a copy, the accepted pair as similarity, and suppresses the remaining 16", () => {
    expect(incident.pairs).toHaveLength(18);
    const assessments = incidentAssessments();

    expect(assessments.get("179:180")).toMatchObject({
      classification: "partial_overlap",
      group: "copies",
    });
    expect(assessments.get("38:42")).toMatchObject({
      classification: "similarity",
      group: "similarity",
    });
    expect(
      [...assessments]
        .filter(([pair]) => pair !== "179:180" && pair !== "38:42")
        .map(([, assessment]) => assessment.group)
    ).toEqual(Array(16).fill("suppressed"));
  });

  test("contains only anonymous numeric evidence copied from the incident cache", () => {
    const serialized = JSON.stringify(incident);
    expect(serialized).not.toMatch(
      /path|title|identity|model|sha256|creator|filename/i
    );
    for (const { duration_a, duration_b, match } of incident.pairs) {
      expect(
        intervalCoverage(
          match.segments.map((segment) => [segment.a_start, segment.a_end]),
          duration_a
        )
      ).toBeCloseTo(match.coverage_a, 6);
      expect(
        intervalCoverage(
          match.segments.map((segment) => [segment.b_start, segment.b_end]),
          duration_b
        )
      ).toBeCloseTo(match.coverage_b, 6);
    }
  });

  test("replays catalogue JSON into a deterministic, identity-free report", async () => {
    const cache = await makeIncidentCache();
    const report = await replayPerceptualRelevance(cache);

    expect(report.counts).toMatchObject({
      unique_pairs: 18,
      raw_matches: 18,
      groups: { copies: 1, similarity: 1, suppressed: 16 },
    });
    expect(
      report.pairs.find((pair) => pair.video_ids.join(":") === "179:180")
    ).toMatchObject({ classification: "partial_overlap", group: "copies" });
    expect(
      report.pairs.find((pair) => pair.video_ids.join(":") === "38:42")
    ).toMatchObject({ classification: "similarity", group: "similarity" });
    expect(JSON.stringify(report)).not.toMatch(/path|title|identity|model/i);
  });

  test("uses the most recently published snapshot even when its owner ID is lower", async () => {
    const cache = await makeIncidentCache();
    const original = incident.pairs.find(
      ({ match }) => key(match.video_a, match.video_b) === "179:180"
    )!;
    const segment = original.match.segments.at(-1)!;
    const replacementMatch = {
      ...original.match,
      segments: [segment],
      coverage_a: (segment.a_end - segment.a_start) / original.duration_a,
      coverage_b: (segment.b_end - segment.b_start) / original.duration_b,
    };
    const result: PerceptualCatalogResult = {
      version: 1,
      revision: CATALOG_REVISION,
      video_id: 179,
      compared_videos: 1,
      skipped_references: 0,
      match_count: 1,
      matches: [replacementMatch],
      truncated_matches: false,
      candidate_limited_pairs: 0,
    };
    const olderPath = join(cache, "catalog-result-180.json");
    const newerPath = join(cache, "catalog-result-179.json");
    await writeFile(newerPath, JSON.stringify({ result }));
    const older = new Date("2026-01-01T00:00:00.000Z");
    const newer = new Date("2026-01-02T00:00:00.000Z");
    await Promise.all([
      utimes(olderPath, older, older),
      utimes(newerPath, newer, newer),
    ]);

    const report = await replayPerceptualRelevance(cache);
    expect(report.counts.raw_matches).toBe(19);
    expect(report.counts.unique_pairs).toBe(18);
    expect(
      report.pairs.find((pair) => pair.video_ids.join(":") === "179:180")
    ).toMatchObject({
      classification: "shared_fragment",
      group: "suppressed",
    });
    expect(report.counts.groups).toEqual({
      copies: 0,
      similarity: 1,
      suppressed: 17,
    });
  });

  test("prints to stdout by default and only creates an explicitly named output", async () => {
    const cache = await makeIncidentCache();
    const before = await cacheSnapshot(cache);
    const stdoutRun = await runCli(["--cache-dir", cache]);
    expect(stdoutRun.exitCode).toBe(0);
    expect(JSON.parse(stdoutRun.stdout)).toMatchObject({
      counts: { groups: { copies: 1, similarity: 1, suppressed: 16 } },
    });

    const output = join(
      dirname(cache),
      `perceptual-report-${crypto.randomUUID()}.json`
    );
    temporaryDirectories.push(output);
    const outputRun = await runCli(["--cache-dir", cache, "--output", output]);
    expect(outputRun.exitCode).toBe(0);
    expect(outputRun.stdout).toBe("");
    expect(JSON.parse(await readFile(output, "utf8"))).toMatchObject({
      counts: { unique_pairs: 18 },
    });
    expect(await cacheSnapshot(cache)).toEqual(before);
  });

  test("fails malformed or missing inputs before creating an output", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "perceptual-replay-errors-")
    );
    temporaryDirectories.push(directory);
    const output = join(directory, "must-not-exist.json");

    const malformed = await runCli(["--unknown", "--output", output]);
    expect(malformed.exitCode).toBe(1);
    expect(await Bun.file(output).exists()).toBe(false);

    const missing = await runCli([
      "--cache-dir",
      join(directory, "missing"),
      "--output",
      output,
    ]);
    expect(missing.exitCode).toBe(1);
    expect(await Bun.file(output).exists()).toBe(false);
  });
});
