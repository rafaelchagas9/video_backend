import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { env } from "@/config/env";
import { authenticateUser } from "@/modules/auth/auth.middleware";
import { stashDemo } from "./stash.demo";
import { BadRequestError, NotFoundError } from "@/utils/errors";
import { stashLinkService } from "./stash-link.service";
import { getStashRuntime } from "./stash.runtime";

const ok = <T extends z.ZodType>(data: T) =>
  z.object({ success: z.literal(true), data });

const jobSchema = z.object({
  id: z.number(),
  kind: z.string(),
  status: z.string(),
  checkpoint: z.unknown(),
  last_error: z.unknown(),
  created_at: z.string(),
  completed_at: z.string().nullable(),
});

export async function stashRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.addHook("preHandler", authenticateUser);

  app.get(
    "/status",
    {
      schema: {
        tags: ["stash"],
        summary: "Stash bridge status and library coverage",
        description:
          "Whether the local Stash answers, which stash-box servers it holds, and how many available " +
          "videos are linked to a Stash scene and have a pHash.",
      },
    },
    async () => ({
      success: true as const,
      data: env.DEMO_MODE ? stashDemo.status() : await stashLinkService.status(),
    })
  );

  app.post(
    "/sync",
    {
      schema: {
        tags: ["stash"],
        summary: "Link videos to Stash and generate their pHashes",
        description:
          "Queues a durable job. Without `video_ids`, every available video missing a link or a pHash " +
          "is synced. Stash scans fingerprints only: no previews, sprites or covers.",
        body: z
          .object({ video_ids: z.array(z.number().int().positive()).max(10_000).optional() })
          .strict()
          .nullish(),
        response: { 200: ok(jobSchema) },
      },
    },
    async (request) => {
      if (env.DEMO_MODE) {
        return {
          success: true as const,
          data: toJobDTO(stashDemo.enqueueSync(request.body?.video_ids)),
        };
      }
      const job = await getStashRuntime().enqueueSync({
        ...(request.body?.video_ids ? { video_ids: request.body.video_ids } : {}),
      });
      return { success: true as const, data: toJobDTO(job) };
    }
  );

  app.get(
    "/jobs/:id",
    {
      schema: {
        tags: ["stash"],
        summary: "A Stash sync or identify job",
        params: z.object({ id: z.coerce.number().int().positive() }),
        response: { 200: ok(jobSchema) },
      },
    },
    async (request) => {
      if (env.DEMO_MODE) {
        return { success: true as const, data: toJobDTO(stashDemo.getJob(request.params.id)) };
      }
      const job = await getStashRuntime().durableJobs.get(request.params.id);
      if (!job || !["stash.sync", "enrichment.identify"].includes(job.kind)) {
        throw new NotFoundError(`Job not found: ${request.params.id}`);
      }
      return { success: true as const, data: toJobDTO(job) };
    }
  );

  app.post(
    "/fingerprints/submit",
    {
      schema: {
        tags: ["stash"],
        summary: "Contribute fingerprints to a stash-box",
        description:
          "Submits the linked files' fingerprints (pHash, OSHASH, duration) to StashDB, FansDB or another " +
          "stash-box through Stash. Only videos whose accepted ID for that source is recorded in Stash are " +
          "sent. Requires `confirm: true`.",
        body: z
          .object({
            video_ids: z.array(z.number().int().positive()).min(1).max(500),
            source: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
            confirm: z.boolean().default(false),
          })
          .strict(),
      },
    },
    async (request) => {
      if (!request.body.confirm) {
        throw new BadRequestError("Explicit confirmation is required to submit fingerprints");
      }
      if (env.DEMO_MODE) {
        return { success: true as const, data: stashDemo.submit(request.body.video_ids) };
      }
      return {
        success: true as const,
        data: await stashLinkService.submitFingerprints(
          request.body.video_ids,
          request.body.source
        ),
      };
    }
  );
}

function toJobDTO(job: {
  id: number;
  kind: string;
  status: string;
  checkpoint: unknown;
  lastError: unknown;
  createdAt: Date;
  completedAt: Date | null;
}) {
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    checkpoint: job.checkpoint,
    last_error: job.lastError,
    created_at: job.createdAt.toISOString(),
    completed_at: job.completedAt?.toISOString() ?? null,
  };
}
