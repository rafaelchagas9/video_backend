import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { env } from "@/config/env";
import { stashDemo } from "@/modules/stash/stash.demo";
import { enrichmentService } from "./enrichment.service";
import {
  identifyFilterSchema,
  identifyOptionsSchema,
  identifyService,
} from "./enrichment.identify.service";

const runIdParams = z.object({ id: z.coerce.number().int().positive() });

const countsSchema = z.object({
  total: z.number(),
  processed: z.number(),
  applied: z.number(),
  queued: z.number(),
  no_match: z.number(),
  unlinked: z.number(),
  errors: z.number(),
});

const runSchema = z.object({
  id: z.number(),
  status: z.string(),
  dry_run: z.boolean(),
  options: identifyOptionsSchema,
  filter: z.record(z.string(), z.unknown()),
  counts: countsSchema,
  error: z.string().nullable(),
  created_at: z.string(),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
});

const itemSchema = z.object({
  id: z.number(),
  video_id: z.number(),
  outcome: z.string(),
  source: z.string().nullable(),
  external_id: z.string().nullable(),
  detail: z.unknown(),
  created_at: z.string(),
});

const ok = <T extends z.ZodType>(data: T) =>
  z.object({ success: z.literal(true), data });

export function registerIdentifyRoutes(fastify: FastifyInstance): void {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/identify/options",
    {
      schema: {
        tags: ["enrichment"],
        summary: "Batch identify defaults",
        response: { 200: ok(identifyOptionsSchema) },
      },
    },
    async () => ({ success: true as const, data: await identifyService.getOptions() })
  );

  app.put(
    "/identify/options",
    {
      schema: {
        tags: ["enrichment"],
        summary: "Save batch identify defaults",
        description: "Partial documents are merged over the current defaults.",
        body: z.record(z.string(), z.unknown()),
        response: { 200: ok(identifyOptionsSchema) },
      },
    },
    async (request) => ({
      success: true as const,
      data: await identifyService.saveOptions({
        ...(await identifyService.getOptions()),
        ...request.body,
      }),
    })
  );

  app.post(
    "/identify",
    {
      schema: {
        tags: ["enrichment"],
        summary: "Start a batch identify run",
        description:
          "Links the selected videos to Stash (scanning and generating pHashes when needed), " +
          "looks them up by fingerprint on each source in order, and applies a match only when it is " +
          "the only one and its pHash and duration agree. Other matches become pending proposals and " +
          "the video gets the review tag. `dry_run` records what would happen without writing.",
        body: z
          .object({
            filter: identifyFilterSchema.default({ unidentified_only: true, limit: 500 }),
            options: z.record(z.string(), z.unknown()).optional(),
            dry_run: z.boolean().default(false),
          })
          .strict(),
        response: { 200: ok(runSchema) },
      },
    },
    async (request) => ({
      success: true as const,
      data: await identifyService.start(request.body),
    })
  );

  app.get(
    "/identify/runs",
    {
      schema: {
        tags: ["enrichment"],
        summary: "Recent batch identify runs",
        response: { 200: ok(z.array(runSchema)) },
      },
    },
    async () => ({ success: true as const, data: await identifyService.listRuns() })
  );

  app.get(
    "/identify/runs/:id",
    {
      schema: {
        tags: ["enrichment"],
        summary: "One batch identify run",
        params: runIdParams,
        response: { 200: ok(runSchema) },
      },
    },
    async (request) => ({
      success: true as const,
      data: await identifyService.getRun(request.params.id),
    })
  );

  app.get(
    "/identify/runs/:id/items",
    {
      schema: {
        tags: ["enrichment"],
        summary: "Per-video outcomes of a run",
        params: runIdParams,
        querystring: z.object({
          outcome: z.enum(["applied", "queued", "no_match", "unlinked", "error"]).optional(),
          page: z.coerce.number().int().positive().default(1),
          per_page: z.coerce.number().int().positive().max(200).default(50),
        }),
        response: {
          200: ok(z.object({ items: z.array(itemSchema), total: z.number() })),
        },
      },
    },
    async (request) => ({
      success: true as const,
      data: await identifyService.listItems(request.params.id, request.query),
    })
  );

  app.post(
    "/identify/runs/:id/cancel",
    {
      schema: {
        tags: ["enrichment"],
        summary: "Cancel a batch identify run",
        params: runIdParams,
        response: { 200: ok(runSchema) },
      },
    },
    async (request) => ({
      success: true as const,
      data: await identifyService.cancel(request.params.id),
    })
  );

  app.post(
    "/creators/external-ids/refresh",
    {
      schema: {
        tags: ["enrichment"],
        summary: "Follow merged and deleted stash-box performers",
        description:
          "Checks every stored stash-box performer ID. IDs merged into another performer are replaced " +
          "by the new ID; deleted IDs and creators that now share one performer are reported for review.",
      },
    },
    async () => ({
      success: true as const,
      data: env.DEMO_MODE
        ? stashDemo.refreshReport()
        : await enrichmentService.refreshCreatorExternalIds(),
    })
  );
}
