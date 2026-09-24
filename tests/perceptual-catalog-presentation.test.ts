import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  stat,
  writeFile,
  utimes,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CATALOG_REVISION,
  PERCEPTUAL_INDEX_REVISION,
  perceptualCatalogResultsSchema,
} from "@/modules/perceptual-duplicates/perceptual-catalog.schemas";

const root = await mkdtemp(join(tmpdir(), "perceptual-presentation-"));
const rows: Array<{
  id: number;
  filePath: string;
  durationSeconds: number;
  title: string;
  fileName: string;
}> = [];
mock.module("@/config/env", () => ({
  env: {
    PERCEPTUAL_DUPLICATES_CACHE_DIR: root,
    PERCEPTUAL_DUPLICATES_WORK_DIR: root,
  },
}));
mock.module("@/config/drizzle", () => ({
  db: { select: () => ({ from: () => ({ where: async () => rows }) }) },
}));
const { perceptualCatalog } =
  await import("@/modules/perceptual-duplicates/perceptual-catalog");
const digest = "a".repeat(64);
const records: Record<string, unknown> = {};
const snapshot = new Map<string, string>();

async function save(name: string, value: unknown) {
  const data = JSON.stringify(value);
  await writeFile(join(root, name), data);
  snapshot.set(name, data);
}
function pair(
  a: number,
  b: number,
  start: number,
  end: number,
  offset: number,
  status: "verified" | "ambiguous"
) {
  const duration = (id: number) =>
    rows.find((r) => r.id === id)!.durationSeconds;
  return {
    video_a: a,
    video_b: b,
    status,
    coverage_a: (end - start) / duration(a),
    coverage_b: (end - start) / duration(b),
    segments: [
      {
        a_start: start,
        a_end: end,
        b_start: offset,
        b_end: offset + end - start,
        speed: 1,
        matched_frames: 12,
        spatial_inliers: 40,
        status,
        motion: 0.1,
        timing_error_seconds: 0.1,
      },
    ],
  };
}

beforeAll(async () => {
  await mkdir(join(root, "models/copies"), { recursive: true });
  await writeFile(
    join(root, "models/copies/sscd_disc_mixup.json"),
    JSON.stringify({ onnx_sha256: digest })
  );
  for (let id = 1; id <= 6; id++) {
    const filePath = join(root, `source-${id}.fixture`);
    await writeFile(filePath, `synthetic non-media source ${id}`);
    const source = await stat(filePath, { bigint: true });
    const durationSeconds = id === 3 ? 35 : id === 4 ? 316 : 60;
    rows.push({
      id,
      filePath,
      durationSeconds,
      title: `Fixture ${id}`,
      fileName: `fixture-${id}`,
    });
    const key = id.toString(16).padStart(64, "0");
    await mkdir(join(root, "indexes", key), { recursive: true });
    const chunkStatus: Record<string, { size: number; mtime_ns: string }> = {};
    for (let c = 0; c < Math.ceil(durationSeconds / 60); c++) {
      const name = `${(c * 60).toFixed(6)}.npz`;
      const path = join(root, "indexes", key, name);
      await writeFile(path, "synthetic descriptor fixture");
      const metadata = await stat(path, { bigint: true });
      chunkStatus[name] = {
        size: Number(metadata.size),
        mtime_ns: metadata.mtimeNs.toString(),
      };
    }
    await writeFile(
      join(root, "indexes", key, "complete.json"),
      JSON.stringify({
        revision: PERCEPTUAL_INDEX_REVISION,
        cache_key: key,
        chunks: chunkStatus,
      })
    );
    records[String(id)] = {
      video: { id, path: filePath, duration_seconds: durationSeconds },
      cache_key: key,
      retrieval_token: key,
      revision: CATALOG_REVISION,
      model_sha256: digest,
      identity: {
        st_dev: source.dev.toString(),
        st_ino: source.ino.toString(),
        st_size: source.size.toString(),
        st_mtime_ns: source.mtimeNs.toString(),
        st_ctime_ns: source.ctimeNs.toString(),
      },
    };
  }
  await save("catalog.json", {
    revision: CATALOG_REVISION,
    model_sha256: digest,
    videos: records,
  });
  await mkdir(join(root, "retrieval-v4"), { recursive: true });
  await save("retrieval-v4/manifest.json", {
    version: 1,
    dimensions: 512,
    index: {
      kind: "exact",
      hnsw_m: 16,
      ef_construction: 80,
      ef_search: 2048,
      scalar_quantizer: "QT_8bit",
    },
    revision: CATALOG_REVISION,
    model_sha256: digest,
    members: Object.fromEntries(
      Object.entries(records).map(([id, record]) => [
        id,
        { token: (record as { retrieval_token: string }).retrieval_token },
      ])
    ),
    shards: [],
  });
  const copy = pair(1, 2, 0, 59, 0, "verified");
  for (let id = 1; id <= 6; id++) {
    const matches =
      id === 1 || id === 2
        ? [copy]
        : id === 4
          ? [pair(3, 4, 11, 24, 48, "ambiguous")]
          : id === 6
            ? [pair(5, 6, 0, 5, 0, "verified")]
            : [];
    await save(`catalog-result-${id}.json`, {
      sources: records,
      result: {
        version: 1,
        revision: CATALOG_REVISION,
        video_id: id,
        compared_videos: 5,
        skipped_references: 0,
        matches,
        match_count: matches.length,
        truncated_matches: false,
        candidate_limited_pairs: id === 6 ? 2 : 0,
      },
    });
  }
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("catalogue presentation without reprocessing", () => {
  test("defaults to copies and deduplicates before pagination", async () => {
    const page = await perceptualCatalog.results({ limit: 1, offset: 0 });
    expect(page.total).toBe(1);
    expect(page.items[0]?.matches).toHaveLength(1);
    expect(page.items[0]?.matches[0]?.assessment.classification).toBe(
      "near_duplicate"
    );
    expect(page.video_labels).toEqual({ "1": "Fixture 1", "2": "Fixture 2" });
    expect(perceptualCatalogResultsSchema.safeParse(page).success).toBe(true);
  });
  test("similarity is opt-in and pagination preserves global incompleteness", async () => {
    const page = await perceptualCatalog.results({
      limit: 1,
      offset: 0,
      view: "similarity",
    });
    expect(page.total).toBe(1);
    expect(page.items[0]?.matches[0]?.assessment.group).toBe("similarity");
    const empty = await perceptualCatalog.results({ limit: 1, offset: 3 });
    expect(empty.items).toEqual([]);
    expect(empty.diagnostics).toEqual({
      retrieval_limited_videos: 0,
      candidate_limited_pairs: 2,
      truncated_videos: 0,
      suppressed_matches: 1,
    });
  });
  test("all source and cache bytes remain unchanged after presentation", async () => {
    for (const [name, data] of snapshot)
      expect(await readFile(join(root, name), "utf8")).toBe(data);
    for (const row of rows)
      expect(await readFile(row.filePath, "utf8")).toBe(
        `synthetic non-media source ${row.id}`
      );
  });
  test("chooses the most recently published valid pair before applying the view", async () => {
    const oldPath = join(root, "catalog-result-2.json");
    const newerPath = join(root, "catalog-result-1.json");
    const old = JSON.parse(snapshot.get("catalog-result-2.json")!);
    old.result.matches = [pair(1, 2, 0, 5, 0, "verified")];
    await writeFile(oldPath, JSON.stringify(old));
    await utimes(oldPath, 1000, 1000);
    await utimes(newerPath, 2000, 2000);
    try {
      const copies = await perceptualCatalog.results({ limit: 20, offset: 0 });
      expect(copies.total).toBe(1);
      expect(copies.items[0]?.video_id).toBe(1);
      // Newer suppressed evidence must likewise supersede an older copy;
      // selecting the requested view cannot cherry-pick stale evidence.
      await utimes(oldPath, 3000, 3000);
      const hidden = await perceptualCatalog.results({ limit: 20, offset: 0 });
      expect(hidden.total).toBe(0);
    } finally {
      await writeFile(oldPath, snapshot.get("catalog-result-2.json")!);
    }
  });
  test("missing or stale global membership makes videos pending again", async () => {
    const path = join(root, "retrieval-v4/manifest.json");
    const before = await readFile(path, "utf8");
    try {
      await rm(path);
      expect((await perceptualCatalog.processedIds(rows)).size).toBe(0);
      const stale = JSON.parse(before);
      stale.members["1"].token = "wrong-generation";
      await writeFile(path, JSON.stringify(stale));
      const processed = await perceptualCatalog.processedIds(rows);
      expect(processed.has(1)).toBe(false);
      expect(processed.has(2)).toBe(true);
      stale.shards = [
        {
          count: 1,
          kind: "exact",
          index: "shard-000000-g000000.faiss",
          metadata: "shard-000000-g000000.npz",
          index_size: 100,
          metadata_size: 100,
        },
      ];
      await writeFile(path, JSON.stringify(stale));
      expect((await perceptualCatalog.processedIds(rows)).size).toBe(0);
    } finally {
      await writeFile(path, before);
    }
  });

  test("descriptor republication cannot reuse prior copy decisions", async () => {
    const paths = ["catalog-result-1.json", "catalog-result-2.json"];
    try {
      for (const mode of ["missing", "different-token", "different-cache"]) {
        for (const name of paths) {
          const saved = JSON.parse(snapshot.get(name)!);
          if (mode === "missing") delete saved.sources["1"].retrieval_token;
          else if (mode === "different-token")
            saved.sources["1"].retrieval_token = "f".repeat(64);
          else saved.sources["1"].cache_key = "e".repeat(64);
          await writeFile(join(root, name), JSON.stringify(saved));
        }
        expect((await perceptualCatalog.results({ limit: 20, offset: 0 })).total).toBe(0);
      }
    } finally {
      for (const name of paths) await writeFile(join(root, name), snapshot.get(name)!);
    }
  });

  test("incompatible retrieval configuration and missing graph template stay pending", async () => {
    const path = join(root, "retrieval-v4/manifest.json");
    const before = await readFile(path, "utf8");
    try {
      for (const update of [
        { version: 2 },
        { dimensions: 256 },
        { index: { ...JSON.parse(before).index, ef_search: 1024 } },
        { index: { ...JSON.parse(before).index, kind: "unknown" } },
        { index: { ...JSON.parse(before).index, kind: "hnswsq8" } },
      ]) {
        await writeFile(path, JSON.stringify({ ...JSON.parse(before), ...update }));
        expect((await perceptualCatalog.processedIds(rows)).size).toBe(0);
      }
      await writeFile(join(root, "retrieval-v4/template.faiss"), "synthetic template");
      expect((await perceptualCatalog.processedIds(rows)).size).toBe(rows.length);
    } finally {
      await rm(join(root, "retrieval-v4/template.faiss"), { force: true });
      await writeFile(path, before);
    }
  });

  test("replaced chunks and unexpected names invalidate completion", async () => {
    const key = "1".padStart(64, "0");
    const folder = join(root, "indexes", key);
    const path = join(folder, "0.000000.npz");
    const statusPath = join(folder, "complete.json");
    const before = await readFile(path);
    const status = JSON.parse(await readFile(statusPath, "utf8"));
    try {
      await writeFile(path, "corrupt");
      expect((await perceptualCatalog.processedIds(rows)).has(1)).toBe(false);
      await rm(path);
      await writeFile(join(folder, "unexpected.npz"), before);
      expect((await perceptualCatalog.processedIds(rows)).has(1)).toBe(false);
    } finally {
      await rm(join(folder, "unexpected.npz"), { force: true });
      await writeFile(path, before);
      status.chunks["0.000000.npz"].mtime_ns = (
        await stat(path, { bigint: true })
      ).mtimeNs.toString();
      await writeFile(statusPath, JSON.stringify(status));
    }
  });
});
