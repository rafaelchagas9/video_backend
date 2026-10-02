import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import { buildDemoCopyResults } from "@/modules/library-sync/library-sync.demo.fixtures";
import { copyDetectionResultsSchema } from "@/modules/copy-detection/copy-detection.schemas";

process.env.DEMO_MODE = "true";
process.env.NODE_ENV = "test";
mock.module("@/modules/auth/auth.middleware", () => ({
  authenticateUser: async () => {},
}));
const catalog = Array.from({ length: 132 }, (_, i) => ({
  id: i + 1,
  durationSeconds: 130 + (i % 44) * 43,
  title: `Demo video ${i + 1}`,
  fileName: `demo-${i + 1}.mp4`,
}));
const root = mkdtempSync(join(tmpdir(), "copy-demo-test-"));
const app = Fastify();
let demo: typeof import("@/database/demo/client");
beforeAll(async () => {
  demo = await import("@/database/demo/client");
  demo.setDemoDatabasePathForTests(join(root, "demo.sqlite"));
  demo.initializeDemoDatabase();
  const { demoVideosTable } = await import("@/database/demo/schema");
  const now = "2026-09-26T12:00:00Z";
  demo
    .getDemoDatabase()
    .insert(demoVideosTable)
    .values(
      catalog.map((v) => ({
        ...v,
        filePath: `demo_mode/${v.fileName}`,
        fileSizeBytes: 100,
        directoryId: 1,
        isAvailable: true,
        indexedAt: now,
        createdAt: now,
        updatedAt: now,
      }))
    )
    .run();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const { librarySyncRoutes } =
    await import("@/modules/library-sync/library-sync.routes");
  await app.register(librarySyncRoutes, { service: null });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  demo?.setDemoDatabasePathForTests(null);
  rmSync(root, { recursive: true, force: true });
});

test("HTTP results paginate and retain the measured match mix without PostgreSQL", async () => {
  const counts: Record<string, number> = {};
  let largestGroup = 0;
  let largestSegments = 0;
  for (const view of ["copies", "similarity"] as const) {
    const seen = new Set<number>();
    let total = Infinity;
    for (let offset = 0; offset < total; offset += 20) {
      const response = await app.inject(
        `/library-sync/perceptual-results?view=${view}&limit=20&offset=${offset}`
      );
      expect(response.statusCode).toBe(200);
      const result = copyDetectionResultsSchema.parse(response.json().data);
      total = result.total;
      expect(result.diagnostics.suppressed_matches).toBe(20);
      for (const group of result.items) {
        expect(seen.has(group.video_id)).toBe(false);
        seen.add(group.video_id);
        largestGroup = Math.max(largestGroup, group.match_count);
        for (const match of group.matches) {
          expect(match.assessment.group).toBe(view);
          counts[match.assessment.classification] =
            (counts[match.assessment.classification] ?? 0) + 1;
          largestSegments = Math.max(largestSegments, match.segments.length);
          const a = catalog[match.video_a - 1];
          const b = catalog[match.video_b - 1];
          expect(result.video_labels?.[String(a.id)]).toBe(a.title);
          expect(result.video_labels?.[String(b.id)]).toBe(b.title);
          expect(group.video_id).toBe(
            a.durationSeconds >= b.durationSeconds ? a.id : b.id
          );
          for (const segment of match.segments) {
            expect(segment.a_end).toBeLessThanOrEqual(a.durationSeconds);
            expect(segment.b_end).toBeLessThanOrEqual(b.durationSeconds);
          }
        }
      }
    }
    expect(seen.size).toBe(total);
    if (view === "copies") expect(total).toBeGreaterThan(20);
  }
  expect(counts).toEqual({
    partial_overlap: 131,
    near_duplicate: 39,
    contained_clip: 6,
    similarity: 4,
  });
  expect(largestGroup).toBe(8);
  expect(largestSegments).toBe(194);
  const { isProductionDatabaseClientInitialized } =
    await import("@/config/drizzle");
  expect(isProductionDatabaseClientInitialized()).toBe(false);
});

test("fixtures are deterministic and handle empty or reduced catalogs and out-of-range pages", () => {
  const input = { limit: 20, offset: 0 };
  expect(buildDemoCopyResults(catalog, input)).toEqual(
    buildDemoCopyResults([...catalog].reverse(), input)
  );
  expect(buildDemoCopyResults([], input).total).toBe(0);
  expect(buildDemoCopyResults(catalog.slice(0, 1), input).items).toEqual([]);
  expect(
    buildDemoCopyResults(catalog, { ...input, offset: 9999 }).items
  ).toEqual([]);
  const small = buildDemoCopyResults(catalog.slice(0, 3), input);
  expect(copyDetectionResultsSchema.safeParse(small).success).toBe(true);
  for (const group of small.items)
    for (const match of group.matches) {
      expect(match.video_a).toBeLessThanOrEqual(3);
      expect(match.video_b).toBeLessThanOrEqual(3);
    }
});
