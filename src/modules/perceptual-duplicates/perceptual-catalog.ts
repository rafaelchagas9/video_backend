import { open, readFile, readdir, stat, lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/config/drizzle";
import { env } from "@/config/env";
import { videosTable } from "@/database/schema";
import { mediaWorkScheduler } from "@/utils/media-work-scheduler";
import { NotFoundError, ValidationError } from "@/utils/errors";
import { PythonPerceptualDuplicatesRunner } from "./perceptual-duplicates.runner";

export {
  perceptualCatalogResultSchema,
  perceptualCatalogResultsSchema,
} from "./perceptual-catalog.schemas";
import {
  CATALOG_REVISION,
  PERCEPTUAL_INDEX_REVISION,
  perceptualCatalogResultSchema,
  validateCatalogResult,
  type PerceptualCatalogResult,
} from "./perceptual-catalog.schemas";
import {
  assessPerceptualMatch,
  PERCEPTUAL_ASSESSMENT_REVISION,
} from "./perceptual-relevance";
import type { PerceptualCatalogResults } from "./perceptual-catalog.schemas";
const recordSchema = z.object({
  retrieval_token: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  cache_key: z.string().regex(/^[a-f0-9]{64}$/),
  video: z.object({
    id: z.number().int().positive(),
    path: z.string(),
    duration_seconds: z.number(),
  }),
  identity: z.record(z.string(), z.string()),
  revision: z.literal(CATALOG_REVISION),
  model_sha256: z.string(),
});
const catalogSchema = z.object({
  revision: z.literal(CATALOG_REVISION),
  model_sha256: z.string(),
  videos: z.record(z.string(), recordSchema),
});
const savedCatalogResultSchema = z.object({
  result: perceptualCatalogResultSchema,
  sources: z.record(z.string(), recordSchema),
});

async function readPublication(videoId: number) {
  try {
    const file = await open(
      resolve(cacheDir(), `catalog-result-${videoId}.json`),
      "r"
    );
    try {
      // Read the bytes and publication timestamp from the same opened inode,
      // even if the worker atomically replaces the pathname during this request.
      const [raw, metadata] = await Promise.all([
        file.readFile("utf8"),
        file.stat(),
      ]);
      return {
        videoId,
        modifiedAt: metadata.mtimeMs,
        saved: savedCatalogResultSchema.parse(JSON.parse(raw)),
      };
    } finally {
      await file.close();
    }
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === "ENOENT" ||
      error instanceof z.ZodError
    )
      return null;
    throw error;
  }
}

type CatalogVideo = {
  id: number;
  filePath: string;
  durationSeconds: number | null;
};
const cacheDir = () => resolve(env.PERCEPTUAL_DUPLICATES_CACHE_DIR);

async function readCatalog() {
  try {
    const modelPath = process.env.COPY_MODEL_PATH
      ? resolve(env.PERCEPTUAL_DUPLICATES_WORK_DIR, process.env.COPY_MODEL_PATH)
      : resolve(
          env.PERCEPTUAL_DUPLICATES_WORK_DIR,
          "models/copies/sscd_disc_mixup.onnx"
        );
    const [raw, manifest, retrievalRaw] = await Promise.all([
      readFile(resolve(cacheDir(), "catalog.json"), "utf8"),
      readFile(modelPath.replace(/\.[^./\\]+$/, ".json"), "utf8"),
      readFile(resolve(cacheDir(), "retrieval-v4/manifest.json"), "utf8"),
    ]);
    const catalog = catalogSchema.parse(JSON.parse(raw));
    const digest = z
      .object({ onnx_sha256: z.string() })
      .parse(JSON.parse(manifest));
    const retrieval = z
      .object({
        // Keep the readiness contract aligned with RetrievalIndex._read_manifest.
        version: z.literal(1),
        revision: z.literal(CATALOG_REVISION),
        model_sha256: z.string(),
        dimensions: z.literal(512),
        index: z.object({
          kind: z.enum(["exact", "hnswsq8"]),
          hnsw_m: z.literal(16),
          ef_construction: z.literal(80),
          ef_search: z.literal(2048),
          scalar_quantizer: z.literal("QT_8bit"),
        }),
        members: z.record(z.string(), z.object({ token: z.string() })),
        shards: z.array(
          z.object({
            count: z.number().int().nonnegative(),
            kind: z.enum(["exact", "hnswsq8"]),
            index: z.string().regex(/^shard-[0-9]+-g[0-9]+\.faiss$/),
            metadata: z.string().regex(/^shard-[0-9]+-g[0-9]+\.npz$/),
            index_size: z.number().int().positive(),
            metadata_size: z.number().int().positive(),
          })
        ),
      })
      .parse(JSON.parse(retrievalRaw));
    if (
      catalog.model_sha256 !== digest.onnx_sha256 ||
      retrieval.model_sha256 !== catalog.model_sha256
    )
      return null;
    if (retrieval.index.kind === "hnswsq8") {
      const template = await lstat(
        resolve(cacheDir(), "retrieval-v4/template.faiss")
      );
      if (!template.isFile()) return null;
    }
    for (let offset = 0; offset < retrieval.shards.length; offset += 16) {
      const present = await Promise.all(
        retrieval.shards.slice(offset, offset + 16).flatMap((shard) =>
          (
            [
              [shard.index, shard.index_size],
              [shard.metadata, shard.metadata_size],
            ] as const
          ).map(async ([name, size]) => {
            try {
              const file = await lstat(
                resolve(cacheDir(), "retrieval-v4", name)
              );
              return file.isFile() && file.size === size;
            } catch {
              return false;
            }
          })
        )
      );
      if (present.some((value) => !value)) return null;
    }
    return { ...catalog, retrievalMembers: retrieval.members };
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === "ENOENT" ||
      error instanceof z.ZodError
    )
      return null;
    throw error;
  }
}
async function matchesIdentity(
  video: CatalogVideo,
  record: z.infer<typeof recordSchema>
) {
  if (
    record.video.id !== video.id ||
    record.video.path !== video.filePath ||
    record.video.duration_seconds !== video.durationSeconds
  )
    return false;
  try {
    const source = await stat(video.filePath, { bigint: true });
    const expected = record.identity;
    return (
      source.isFile() &&
      source.dev.toString() === expected.st_dev &&
      source.ino.toString() === expected.st_ino &&
      source.size.toString() === expected.st_size &&
      source.mtimeNs.toString() === expected.st_mtime_ns &&
      source.ctimeNs.toString() === expected.st_ctime_ns
    );
  } catch {
    return false;
  }
}
async function availableVideos() {
  return db
    .select({
      id: videosTable.id,
      filePath: videosTable.filePath,
      durationSeconds: videosTable.durationSeconds,
      title: videosTable.title,
      fileName: videosTable.fileName,
    })
    .from(videosTable)
    .where(eq(videosTable.isAvailable, true));
}

export const perceptualCatalog = {
  async processedIds(videos: CatalogVideo[]): Promise<Set<number>> {
    const catalog = await readCatalog();
    const found = new Set<number>();
    if (!catalog) return found;
    // Bounded I/O concurrency: do not stat an entire network library at once.
    for (let offset = 0; offset < videos.length; offset += 16) {
      await Promise.all(
        videos.slice(offset, offset + 16).map(async (video) => {
          const record = catalog.videos[String(video.id)];
          if (
            record?.retrieval_token &&
            catalog.retrievalMembers[String(video.id)]?.token ===
              record.retrieval_token &&
            (await matchesIdentity(video, record))
          ) {
            try {
              const folder = resolve(cacheDir(), "indexes", record.cache_key);
              const chunks = (await readdir(folder))
                .filter((name) => name.endsWith(".npz"))
                .sort();
              const expected = Array.from(
                { length: Math.ceil(record.video.duration_seconds / 60) },
                (_, index) => `${(index * 60).toFixed(6)}.npz`
              ).sort();
              if (
                chunks.length !== expected.length ||
                chunks.some((name, i) => name !== expected[i])
              )
                return;
              const status = z
                .object({
                  revision: z.literal(PERCEPTUAL_INDEX_REVISION),
                  cache_key: z.literal(record.cache_key),
                  chunks: z.record(
                    z.string(),
                    z.object({
                      size: z.number().int().positive(),
                      mtime_ns: z.string(),
                    })
                  ),
                })
                .parse(
                  JSON.parse(
                    await readFile(resolve(folder, "complete.json"), "utf8")
                  )
                );
              for (let offset = 0; offset < expected.length; offset += 16) {
                const intact = await Promise.all(
                  expected.slice(offset, offset + 16).map(async (name) => {
                    const file = await lstat(resolve(folder, name), {
                      bigint: true,
                    });
                    const before = status.chunks[name];
                    return (
                      file.isFile() &&
                      before &&
                      file.size === BigInt(before.size) &&
                      file.mtimeNs.toString() === before.mtime_ns
                    );
                  })
                );
                if (intact.some((value) => !value)) return;
              }
              found.add(video.id);
            } catch {
              /* Removed derived indexes become pending again. */
            }
          }
        })
      );
    }
    return found;
  },

  async process(
    videoId: number,
    signal: AbortSignal
  ): Promise<PerceptualCatalogResult> {
    return mediaWorkScheduler.run(
      "background",
      async () => {
        const all = await availableVideos();
        const video = all.find((item) => item.id === videoId);
        if (!video) throw new NotFoundError("Video is unavailable");
        if (
          !video.durationSeconds ||
          video.durationSeconds < 5 ||
          video.durationSeconds > 86400
        ) {
          throw new ValidationError(
            "Perceptual indexing requires a video between 5 seconds and 24 hours"
          );
        }
        const before = await stat(video.filePath, { bigint: true });
        const runner = new PythonPerceptualDuplicatesRunner({
          pythonPath: env.PERCEPTUAL_DUPLICATES_PYTHON_PATH,
          moduleName: "vision_service.video_copy_catalog",
          workDir: env.PERCEPTUAL_DUPLICATES_WORK_DIR,
          cacheDir: cacheDir(),
          timeoutMs: env.PERCEPTUAL_DUPLICATES_TIMEOUT_MS,
          maxOutputBytes: env.PERCEPTUAL_DUPLICATES_MAX_OUTPUT_BYTES,
          environment: {
            FFMPEG_PATH: env.FFMPEG_PATH,
            VAAPI_DEVICE: env.VAAPI_DEVICE,
            COPY_CACHE_MAX_BYTES:
              process.env.COPY_CACHE_MAX_BYTES ?? String(128 * 1024 ** 3),
          },
        });
        const result = await runner.runRequest(
          {
            video: {
              id: video.id,
              path: video.filePath,
              duration_seconds: video.durationSeconds,
            },
            reference_ids: all.map((item) => item.id),
          },
          signal,
          (value) => {
            return validateCatalogResult(
              value,
              videoId,
              new Map(all.map((item) => [item.id, item.durationSeconds ?? 0]))
            );
          }
        );
        const after = await stat(video.filePath, { bigint: true });
        const [current] = await db
          .select({ path: videosTable.filePath })
          .from(videosTable)
          .where(
            and(eq(videosTable.id, videoId), eq(videosTable.isAvailable, true))
          );
        if (
          current?.path !== video.filePath ||
          before.dev !== after.dev ||
          before.ino !== after.ino ||
          before.size !== after.size ||
          before.mtimeNs !== after.mtimeNs ||
          before.ctimeNs !== after.ctimeNs
        ) {
          throw new Error("Video changed during catalogue comparison");
        }
        return result;
      },
      signal
    );
  },

  async results({
    limit,
    offset,
    view = "copies",
  }: {
    limit: number;
    offset: number;
    view?: "copies" | "similarity";
  }): Promise<PerceptualCatalogResults> {
    const all = await availableVideos();
    const processed = await this.processedIds(all);
    const catalog = await readCatalog();
    const items: PerceptualCatalogResults["items"] = [];
    const diagnostics = {
      candidate_limited_pairs: 0,
      truncated_videos: 0,
      suppressed_matches: 0,
      retrieval_limited_videos: 0,
    };
    const assessment_revision = PERCEPTUAL_ASSESSMENT_REVISION;
    const seen = new Set<string>();
    if (!catalog)
      return {
        items,
        total: 0,
        limit,
        offset,
        diagnostics,
        assessment_revision,
      };
    const publications: NonNullable<
      Awaited<ReturnType<typeof readPublication>>
    >[] = [];
    const ids = [...processed];
    for (let i = 0; i < ids.length; i += 16) {
      const batch = await Promise.all(
        ids.slice(i, i + 16).map(readPublication)
      );
      for (const publication of batch)
        if (publication) publications.push(publication);
    }
    // A pair may be republished by either endpoint. Newest valid publication
    // wins regardless of owner ID or requested view; ties are deterministic.
    publications.sort(
      (a, b) => b.modifiedAt - a.modifiedAt || b.videoId - a.videoId
    );
    for (const { videoId, saved } of publications) {
      try {
        const item = saved.result;
        if (item.video_id !== videoId) continue;
        const currentSource = (id: number) => {
          const before = saved.sources[String(id)];
          const current = catalog.videos[String(id)];
          return (
            processed.has(id) &&
            before &&
            current &&
            before.video.id === id &&
            current.video.id === id &&
            before.video.path === current.video.path &&
            before.video.duration_seconds === current.video.duration_seconds &&
            before.model_sha256 === current.model_sha256 &&
            before.cache_key === current.cache_key &&
            Boolean(before.retrieval_token) &&
            before.retrieval_token === current.retrieval_token &&
            Object.entries(before.identity).every(
              ([key, value]) => current.identity[key] === value
            )
          );
        };
        if (!currentSource(videoId)) continue;
        diagnostics.candidate_limited_pairs += item.candidate_limited_pairs;
        diagnostics.retrieval_limited_videos += Number(
          item.retrieval_truncated ?? false
        );
        diagnostics.truncated_videos += Number(item.truncated_matches);
        const currentMatches = item.matches.filter((match) => {
          const key = [match.video_a, match.video_b]
            .sort((a, b) => a - b)
            .join(":");
          if (
            seen.has(key) ||
            !currentSource(match.video_a) ||
            !currentSource(match.video_b)
          )
            return false;
          seen.add(key);
          return true;
        });
        const matches = currentMatches
          .map((match) => ({
            ...match,
            assessment: assessPerceptualMatch(
              match,
              catalog.videos[String(match.video_a)]!.video.duration_seconds,
              catalog.videos[String(match.video_b)]!.video.duration_seconds
            ),
          }))
          .filter((match) => {
            if (match.assessment.group === "suppressed")
              diagnostics.suppressed_matches++;
            return match.assessment.group === view;
          });
        if (matches.length)
          items.push({
            ...item,
            matches,
            // After invalidation/deduplication only the visible count is known.
            // Keep the truncation notice: omitted pairs were never persisted.
            match_count:
              item.truncated_matches && matches.length === item.matches.length
                ? item.match_count
                : matches.length,
          });
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== "ENOENT" &&
          !(error instanceof z.ZodError)
        )
          throw error;
      }
    }
    const page = items.slice(offset, offset + limit);
    const visible = new Set(
      page.flatMap((item) =>
        item.matches.flatMap((match) => [match.video_a, match.video_b])
      )
    );
    const video_labels = Object.fromEntries(
      all
        .filter((video) => visible.has(video.id))
        .map((video) => [
          String(video.id),
          video.title?.trim() || video.fileName,
        ])
    );
    return {
      items: page,
      video_labels,
      total: items.length,
      limit,
      offset,
      diagnostics,
      assessment_revision,
    };
  },
};
