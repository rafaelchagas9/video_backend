import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { TestApp } from "../helpers/test-app";
import { createTestApp, seedVideoFixture } from "../helpers/test-app";

/**
 * Stash-derived enrichment rules end to end over HTTP and PostgreSQL: unique
 * name matching, merged stash-box performers, the candidate policy, studio
 * parent chains, Stash scene links, and batch identify. The Python service
 * (and through it Stash) is mocked.
 */

type Candidate = {
  type: string;
  value: string;
  source: string;
  field_key?: string;
  confidence?: number;
  raw?: Record<string, unknown>;
};
type Response = { candidates: Candidate[]; sources_used: string[]; errors: string[] };

let enrichResponse: Response = { candidates: [], sources_used: ["stashdb"], errors: [] };
let batchResponses: Response[] = [];
const identities = new Map<string, Record<string, unknown>>();
const enrichRequests: Array<Record<string, unknown>> = [];
const bridgeCalls: Array<{ path: string; body: unknown }> = [];
const knownFiles = new Map<string, Record<string, unknown>>();

const match = (externalId: string, extra: Record<string, unknown> = {}) => ({
  entity_type: "scene",
  source: "stashdb",
  external_id: externalId,
  name: `Scene ${externalId}`,
  ...extra,
});
const sceneCandidates = (externalId: string, evidence: Record<string, unknown>, rank = 0): Candidate[] => {
  const m = match(externalId, { rank, evidence, matched_by: "fingerprint" });
  return [
    { type: "external_id", value: externalId, source: "stashdb", raw: { match: m } },
    { type: "field", field_key: "title", value: `Title ${externalId}`, source: "stashdb", raw: { match: m } },
    {
      type: "performer",
      value: `Performer ${externalId}`,
      source: "stashdb",
      raw: { external_id: `p-${externalId}`, source: "stashdb", gender: "FEMALE", match: m },
    },
  ];
};
const STRONG = { exact_hash: false, phash_matches: 1, phash_total: 2, duration_matches: 3, duration_total: 3, scene_duration_diff: 0.4 };

describe("stash-derived enrichment rules", () => {
  let ctx: TestApp | undefined;
  let db: typeof import("@/config/drizzle").db;
  let schema: typeof import("@/database/schema");

  beforeAll(async () => {
    mock.module("@/modules/enrichment/enrichment.client", () => ({
      getEnrichmentClient: () => ({
        enrich: async (request: Record<string, unknown>) => {
          enrichRequests.push(request);
          return enrichResponse;
        },
        enrichBatch: async (requests: unknown[]) => {
          enrichRequests.push(...(requests as Array<Record<string, unknown>>));
          return batchResponses;
        },
        performerIdentity: async (source: string, ids: string[]) => ({
          source,
          results: ids.map((id) => identities.get(id) ?? { requested_id: id, supported: true, found: true, id, merged: false }),
        }),
        request: async (path: string, _method?: string, body?: unknown) => {
          bridgeCalls.push({ path, body });
          if (path === "/stash/library/ensure") return { added: [] };
          if (path === "/stash/scenes/lookup") {
            return Object.fromEntries(((body as { paths: string[] }).paths).map((p) => [p, knownFiles.get(p) ?? null]));
          }
          if (path === "/stash/scan") return { job_id: "9" };
          if (path.startsWith("/stash/jobs/")) return { id: "9", status: "FINISHED" };
          return {};
        },
        healthCheck: async () => ({ status: "healthy" }),
      }),
      resetEnrichmentClient: () => {},
    }));
    ctx = await createTestApp();
    ({ db } = await import("@/config/drizzle"));
    schema = await import("@/database/schema");
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(() => {
    enrichRequests.length = 0;
    bridgeCalls.length = 0;
    identities.clear();
  });

  async function createCreator(name: string, stashdbId?: string): Promise<number> {
    const res = await ctx!.authInject({ method: "POST", url: "/api/creators", payload: { name } });
    expect(res.statusCode).toBe(201);
    const id = res.json().data.id as number;
    if (stashdbId) {
      await db.insert(schema.creatorExternalIdsTable).values({ creatorId: id, source: "stashdb", externalId: stashdbId });
    }
    return id;
  }

  async function runScene(videoId: number, candidates: Candidate[], payload: Record<string, unknown> = {}) {
    enrichResponse = { candidates, sources_used: ["stashdb"], errors: [] };
    const res = await ctx!.authInject({ method: "POST", url: `/api/enrichment/scene/${videoId}/run`, payload });
    expect(res.statusCode).toBe(200);
    const list = await ctx!.authInject({
      method: "GET",
      url: `/api/enrichment/suggestions?entity_type=scene&entity_id=${videoId}&status=pending`,
    });
    return list.json().data as Array<{ id: number; type: string; value: string; raw: Record<string, unknown> }>;
  }

  async function resolution(videoId: number) {
    const res = await ctx!.authInject({ method: "GET", url: `/api/enrichment/scene/${videoId}/resolution` });
    expect(res.statusCode).toBe(200);
    return res.json().data as Array<{ suggestion_id: number; match: { id: number; via: string } | null; ambiguous: Array<{ id: number }>; requires_choice: string | null }>;
  }

  async function resolve(body: Record<string, unknown>) {
    const res = await ctx!.authInject({ method: "POST", url: "/api/enrichment/suggestions/resolve", payload: body });
    expect(res.statusCode).toBe(200);
    return res.json().data as { accepted: number[]; failed: Array<{ id: number; message: string }> };
  }

  it("links a name only when exactly one creator has it, and accepts a choice", async () => {
    // Creator names are unique in Kura; a shared alias is where names collide.
    const first = await createCreator("Twin First");
    const second = await createCreator("Twin Second");
    await db.insert(schema.creatorAliasesTable).values([
      { creatorId: first, name: "Twin Name" },
      { creatorId: second, name: "Twin Name" },
    ]);
    const { videoId } = await seedVideoFixture();
    const [suggestion] = await runScene(videoId, [
      { type: "performer", value: "Twin Name", source: "stashdb", raw: { external_id: "twin-1", source: "stashdb" } },
    ]);
    const [preview] = await resolution(videoId);
    expect(preview!.match).toBeNull();
    expect(preview!.ambiguous.map((a) => a.id).sort()).toEqual([first, second].sort());

    const refused = await resolve({ accept: [suggestion!.id] });
    expect(refused.failed[0]!.message).toContain("choose one");

    const chosen = await resolve({ accept: [suggestion!.id], choices: { [suggestion!.id]: { target_id: second } } });
    expect(chosen.accepted).toEqual([suggestion!.id]);
    const links = await db.select().from(schema.videoCreatorsTable).where(eq(schema.videoCreatorsTable.videoId, videoId));
    expect(links.map((l) => l.creatorId)).toEqual([second]);
    const [ext] = await db.select().from(schema.creatorExternalIdsTable).where(eq(schema.creatorExternalIdsTable.externalId, "twin-1"));
    expect(ext!.creatorId).toBe(second);
  });

  it("never matches by name a creator holding a different ID from the same source", async () => {
    const other = await createCreator("Shared Stage Name", "someone-else");
    const { videoId } = await seedVideoFixture();
    await runScene(videoId, [
      { type: "performer", value: "Shared Stage Name", source: "stashdb", raw: { external_id: "this-one", source: "stashdb" } },
    ]);
    const [preview] = await resolution(videoId);
    expect(preview!.match).toBeNull();
    expect(preview!.ambiguous).toEqual([]);
    expect(other).toBeGreaterThan(0);
  });

  it("finds a creator stored under a merged stash-box ID and replaces that ID", async () => {
    const creator = await createCreator("Old Stage Name", "old-id");
    identities.set("new-id", { requested_id: "new-id", supported: true, found: true, id: "new-id", merged: false, merged_ids: ["old-id"] });
    const { videoId } = await seedVideoFixture();
    const [suggestion] = await runScene(videoId, [
      { type: "performer", value: "New Stage Name", source: "stashdb", raw: { external_id: "new-id", source: "stashdb" } },
    ]);
    expect(suggestion!.raw.merged_ids).toEqual(["old-id"]);
    const [preview] = await resolution(videoId);
    expect(preview!.match).toMatchObject({ id: creator, via: "merged_id" });

    expect((await resolve({ accept: [suggestion!.id] })).accepted).toEqual([suggestion!.id]);
    const ids = await db.select().from(schema.creatorExternalIdsTable).where(eq(schema.creatorExternalIdsTable.creatorId, creator));
    expect(ids.map((row) => row.externalId)).toEqual(["new-id"]);
  });

  it("applies the gender, excluded-tag and single-name rules", async () => {
    const saved = await ctx!.authInject({
      method: "PATCH",
      url: "/api/settings",
      payload: { settings: { enrichment_performer_genders: "FEMALE", enrichment_exclude_tag_patterns: "^4k$" } },
    });
    expect(saved.statusCode).toBe(200);
    const stored = (saved.json().data as Array<{ key: string; value: unknown }>).find((s) => s.key === "enrichment_exclude_tag_patterns");
    expect(stored!.value).toBe("^4k$");

    const { videoId } = await seedVideoFixture();
    const pending = await runScene(videoId, [
      { type: "performer", value: "Jane Policy", source: "stashdb", raw: { external_id: "jp", source: "stashdb", gender: "FEMALE" } },
      { type: "performer", value: "John Policy", source: "stashdb", raw: { external_id: "jm", source: "stashdb", gender: "MALE" } },
      { type: "performer", value: "Mononym", source: "stashdb", raw: { external_id: "mono", source: "stashdb", gender: "FEMALE" } },
      { type: "tag", value: "4K", source: "stashdb", raw: { external_id: "t4k", source: "stashdb" } },
      { type: "tag", value: "Outdoors Policy", source: "stashdb", raw: { external_id: "tout", source: "stashdb" } },
    ]);
    expect(pending.map((s) => s.value).sort()).toEqual(["Jane Policy", "Mononym", "Outdoors Policy"]);

    const mono = pending.find((s) => s.value === "Mononym")!;
    const preview = (await resolution(videoId)).find((p) => p.suggestion_id === mono.id)!;
    expect(preview.requires_choice).toBe("single_name");
    expect((await resolve({ accept: [mono.id] })).failed[0]!.message).toContain("single name");
    expect((await resolve({ accept: [mono.id], choices: { [mono.id]: { create: true } } })).accepted).toEqual([mono.id]);

    await ctx!.authInject({
      method: "PATCH",
      url: "/api/settings",
      payload: { settings: { enrichment_performer_genders: "", enrichment_exclude_tag_patterns: "" } },
    });
  });

  it("gives an accepted studio its network chain", async () => {
    const { videoId } = await seedVideoFixture();
    const [studio] = await runScene(videoId, [
      {
        type: "studio",
        value: "Chain Label",
        source: "stashdb",
        raw: { external_id: "label-1", source: "stashdb", parents: [{ name: "Chain Network", external_id: "net-1" }] },
      },
    ]);
    await resolve({ accept: [studio!.id] });
    const [label] = await db.select().from(schema.studiosTable).where(eq(schema.studiosTable.name, "Chain Label"));
    const [network] = await db.select().from(schema.studiosTable).where(eq(schema.studiosTable.name, "Chain Network"));
    expect(label!.parentStudioId).toBe(network!.id);
  });

  it("sends the Stash scene and the pre-conversion hash, except for a title search", async () => {
    const { videoId } = await seedVideoFixture();
    await db.insert(schema.stashSceneLinksTable).values({ videoId, stashSceneId: "77", stashFileId: "1", filePath: "/x", hasPhash: true });
    await db.insert(schema.videoFingerprintsTable).values({ videoId, algorithm: "OSHASH", hash: "0123456789abcdef", origin: "pre_conversion", durationSeconds: 120 });

    await runScene(videoId, [{ type: "external_id", value: "s-1", source: "stashdb", raw: { match: match("s-1") } }]);
    expect(enrichRequests.at(-1)).toMatchObject({
      stash_scene_id: "77",
      fingerprints: [{ algorithm: "OSHASH", hash: "0123456789abcdef", duration: 120 }],
    });

    await runScene(videoId, [], { search_name: "Some Title" });
    expect(enrichRequests.at(-1)!.stash_scene_id).toBeUndefined();
    expect(enrichRequests.at(-1)!.fingerprints).toBeUndefined();

    // Accepting the scene's stash-box ID records it on the Stash scene.
    const [external] = (await runScene(videoId, [{ type: "external_id", value: "s-2", source: "stashdb", raw: { match: match("s-2") } }]))
      .filter((s) => s.value === "s-2");
    await resolve({ accept: [external!.id] });
    expect(bridgeCalls.find((call) => call.path === "/stash/scenes/77/stash-ids")?.body).toEqual({ source: "stashdb", stash_id: "s-2" });
  });

  it("follows merged and deleted stored performer IDs", async () => {
    const merged = await createCreator("Refresh Merged", "stale-1");
    const deleted = await createCreator("Refresh Deleted", "gone-1");
    identities.set("stale-1", { requested_id: "stale-1", supported: true, found: true, id: "fresh-1", merged: true });
    identities.set("gone-1", { requested_id: "gone-1", supported: true, found: false });
    const res = await ctx!.authInject({ method: "POST", url: "/api/enrichment/creators/external-ids/refresh" });
    expect(res.statusCode).toBe(200);
    const report = res.json().data;
    expect(report.merged).toContainEqual({ creator_id: merged, source: "stashdb", from: "stale-1", to: "fresh-1" });
    expect(report.deleted).toContainEqual({ creator_id: deleted, source: "stashdb", external_id: "gone-1" });
    const [row] = await db.select().from(schema.creatorExternalIdsTable).where(eq(schema.creatorExternalIdsTable.creatorId, merged));
    expect(row!.externalId).toBe("fresh-1");
  });

  it("keeps the original OSHASH when a conversion replaces the file", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { computeVideoOshash } = await import("@/modules/enrichment/enrichment.fingerprint");
    const { stashLinkService } = await import("@/modules/stash/stash-link.service");
    const dir = await mkdtemp(join(tmpdir(), "kura-oshash-"));
    const original = join(dir, "original.mp4");
    await writeFile(original, Buffer.alloc(300 * 1024, 7));
    const { videoId } = await seedVideoFixture();
    try {
      await stashLinkService.recordPreConversion(videoId, original, 120);
      const rows = await db.select().from(schema.videoFingerprintsTable).where(eq(schema.videoFingerprintsTable.videoId, videoId));
      expect(rows).toMatchObject([
        { algorithm: "OSHASH", hash: await computeVideoOshash(original), origin: "pre_conversion", durationSeconds: 120, filePath: original },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("links files Stash knows and replaces only the current file's hashes", async () => {
    const { stashLinkService } = await import("@/modules/stash/stash-link.service");
    const { videoId } = await seedVideoFixture("stash-known.mp4");
    const filePath = "/tmp/stash-known.mp4";
    await db.insert(schema.videoFingerprintsTable).values({ videoId, algorithm: "OSHASH", hash: "aaaaaaaaaaaaaaaa", origin: "pre_conversion" });
    knownFiles.set(filePath, { scene_id: "501", file_id: "9", duration: 120, fingerprints: { oshash: "BBBBBBBBBBBBBBBB", phash: "cccccccccccccccc" }, stash_ids: [] });
    const first = await stashLinkService.syncVideos([videoId]);
    expect(first).toMatchObject({ total: 1, linked: 1, with_phash: 1, missing: [] });
    expect(bridgeCalls.some((call) => call.path === "/stash/scan" || call.path === "/stash/phash")).toBe(false);

    knownFiles.set(filePath, { scene_id: "501", file_id: "10", duration: 121, fingerprints: { oshash: "dddddddddddddddd", phash: "cccccccccccccccc" }, stash_ids: [] });
    await stashLinkService.syncVideos([videoId]);
    const [link] = await db.select().from(schema.stashSceneLinksTable).where(eq(schema.stashSceneLinksTable.videoId, videoId));
    expect(link).toMatchObject({ stashSceneId: "501", stashFileId: "10", hasPhash: true });
    const hashes = await db.select().from(schema.videoFingerprintsTable).where(eq(schema.videoFingerprintsTable.videoId, videoId));
    expect(hashes.map((h) => `${h.origin}:${h.algorithm}:${h.hash}`).sort()).toEqual([
      "pre_conversion:OSHASH:aaaaaaaaaaaaaaaa",
      "stash:OSHASH:dddddddddddddddd",
      "stash:PHASH:cccccccccccccccc",
    ]);
    expect(await stashLinkService.videosNeedingSync({ ids: [videoId] })).toEqual([]);
  });

  describe("batch identify", () => {
    async function linkedVideo(name: string) {
      const { videoId } = await seedVideoFixture(`${name}.mp4`);
      await db.insert(schema.stashSceneLinksTable).values({
        videoId,
        stashSceneId: `scene-${videoId}`,
        stashFileId: "1",
        filePath: `/tmp/${name}.mp4`,
        hasPhash: true,
      });
      await db.update(schema.videosTable).set({ title: null }).where(eq(schema.videosTable.id, videoId));
      return videoId;
    }

    async function runIdentify(videoIds: number[], dryRun: boolean) {
      const started = await ctx!.authInject({
        method: "POST",
        url: "/api/enrichment/identify",
        payload: { filter: { video_ids: videoIds, unidentified_only: false }, dry_run: dryRun },
      });
      expect(started.statusCode).toBe(200);
      const run = started.json().data as { id: number; status: string };
      expect(run.status).toBe("queued");
      const { identifyService } = await import("@/modules/enrichment/enrichment.identify.service");
      await identifyService.handleJob(
        { payload: { run_id: run.id } } as never,
        { signal: new AbortController().signal, checkpoint: async () => {}, heartbeat: async () => {} }
      );
      const finished = await ctx!.authInject({ method: "GET", url: `/api/enrichment/identify/runs/${run.id}` });
      const items = await ctx!.authInject({ method: "GET", url: `/api/enrichment/identify/runs/${run.id}/items` });
      return { run: finished.json().data, items: items.json().data.items as Array<{ video_id: number; outcome: string; detail: Record<string, unknown> }> };
    }

    it("dry run records the plan without writing", async () => {
      const strong = await linkedVideo("identify-dry");
      batchResponses = [{ candidates: sceneCandidates("dry-1", STRONG), sources_used: ["stashdb"], errors: [] }];
      const { run, items } = await runIdentify([strong], true);
      expect(run.status).toBe("completed");
      expect(items[0]).toMatchObject({ video_id: strong, outcome: "applied" });
      expect((items[0]!.detail.plan as Array<{ type: string; action: string }>).map((p) => [p.type, p.action])).toEqual([
        ["external_id", "accept"],
        ["field", "accept"],
        ["performer", "accept"],
      ]);
      const [video] = await db.select().from(schema.videosTable).where(eq(schema.videosTable.id, strong));
      expect(video!.title).toBeNull();
      expect(await db.select().from(schema.enrichmentSuggestionsTable).where(eq(schema.enrichmentSuggestionsTable.entityId, strong))).toEqual([]);
    });

    it("applies a unique fingerprint match, queues the rest, and marks unlinked files", async () => {
      const strong = await linkedVideo("identify-strong");
      const ambiguous = await linkedVideo("identify-two");
      const weak = await linkedVideo("identify-weak");
      const { videoId: unlinked } = await seedVideoFixture("identify-unlinked.mp4");
      const weakEvidence = { exact_hash: false, phash_matches: 0, phash_total: 1, duration_matches: 1, duration_total: 1, scene_duration_diff: 1 };
      batchResponses = [
        { candidates: sceneCandidates("strong-1", STRONG), sources_used: ["stashdb"], errors: [] },
        { candidates: [...sceneCandidates("two-a", STRONG, 0), ...sceneCandidates("two-b", STRONG, 1)], sources_used: ["stashdb"], errors: [] },
        { candidates: sceneCandidates("weak-1", weakEvidence), sources_used: ["stashdb"], errors: [] },
      ];
      const { run, items } = await runIdentify([strong, ambiguous, weak, unlinked], false);
      expect(run.counts).toMatchObject({ total: 4, processed: 4, applied: 1, queued: 2, unlinked: 1 });
      const outcome = (id: number) => items.find((item) => item.video_id === id)!;
      expect(outcome(ambiguous).detail.reason).toBe("2 matches");
      expect(outcome(weak).detail.reason).toBe("no pHash match");
      expect(outcome(unlinked).outcome).toBe("unlinked");
      // Stash was asked to scan the unlinked file first.
      expect(bridgeCalls.some((call) => call.path === "/stash/scan")).toBe(true);

      const [video] = await db.select().from(schema.videosTable).where(eq(schema.videosTable.id, strong));
      expect(video!.title).toBe("Title strong-1");
      const [external] = await db.select().from(schema.videoExternalIdsTable).where(eq(schema.videoExternalIdsTable.videoId, strong));
      expect(external!.externalId).toBe("strong-1");
      expect((await db.select().from(schema.videoCreatorsTable).where(eq(schema.videoCreatorsTable.videoId, strong))).length).toBe(1);

      const [reviewTag] = await db.select().from(schema.tagsTable).where(eq(schema.tagsTable.name, "identify: needs review"));
      const tagged = await db.select().from(schema.videoTagsTable).where(eq(schema.videoTagsTable.tagId, reviewTag!.id));
      expect(tagged.map((t) => t.videoId).sort()).toEqual([ambiguous, weak].sort());
      const pending = await db
        .select()
        .from(schema.enrichmentSuggestionsTable)
        .where(and(eq(schema.enrichmentSuggestionsTable.entityId, ambiguous), eq(schema.enrichmentSuggestionsTable.status, "pending")));
      expect(pending.filter((s) => s.type === "external_id").map((s) => s.value).sort()).toEqual(["two-a", "two-b"]);

      // A reset undoes the auto-applied match like a manual one.
      const reset = await ctx!.authInject({ method: "POST", url: `/api/enrichment/scene/${strong}/reset` });
      expect(reset.statusCode).toBe(200);
      const [after] = await db.select().from(schema.videosTable).where(eq(schema.videosTable.id, strong));
      expect(after!.title).toBeNull();
      expect(await db.select().from(schema.videoCreatorsTable).where(eq(schema.videoCreatorsTable.videoId, strong))).toEqual([]);
    });
  });
});
