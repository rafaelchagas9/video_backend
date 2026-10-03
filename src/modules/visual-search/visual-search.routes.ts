import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { authenticateUser } from "@/modules/auth/auth.middleware";
import { visualSearchService } from "./visual-search.service";

const ids = z.array(z.number().int().positive()).max(200).optional();
const filtersSchema = z
  .object({
    creator_ids: ids,
    tag_ids: ids,
    studio_ids: ids,
    exclude_tag_ids: ids,
    untagged: z.boolean().optional(),
    unwatched: z.boolean().optional(),
  })
  .default({});

const momentSchema = z.object({
  start_seconds: z.number(),
  end_seconds: z.number(),
  peak_seconds: z.number(),
  score: z.number(),
});
const searchResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    results: z.array(
      z.object({
        video_id: z.number(),
        score: z.number(),
        hits: z.number(),
        moments: z.array(momentSchema),
      })
    ),
    top_score: z.number(),
    searched_videos: z.number().nullable(),
    took_ms: z.number(),
  }),
});
const queryDtoSchema = z.object({
  id: z.number(),
  tag_id: z.number(),
  query: z.string(),
  created_at: z.string(),
});

function toFilters(filters: z.infer<typeof filtersSchema>) {
  return {
    creatorIds: filters.creator_ids,
    tagIds: filters.tag_ids,
    studioIds: filters.studio_ids,
    excludeTagIds: filters.exclude_tag_ids,
    untagged: filters.untagged,
    unwatched: filters.unwatched,
  };
}

const tagParams = z.object({ tagId: z.coerce.number().int().positive() });

export async function visualSearchRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.addHook("preHandler", authenticateUser);

  app.get(
    "/status",
    {
      schema: {
        tags: ["visual-search"],
        summary: "Visual search readiness",
        description: "Model readiness in the vision service and how much of the library is indexed.",
        response: {
          200: z.object({
            success: z.literal(true),
            data: z.object({
              ready: z.boolean(),
              state: z.string(),
              model_revision: z.string().nullable(),
              indexed_videos: z.number(),
              indexed_frames: z.number(),
            }),
          }),
        },
      },
    },
    async () => ({ success: true as const, data: await visualSearchService.status() })
  );

  app.post(
    "/",
    {
      schema: {
        tags: ["visual-search"],
        summary: "Search the library by description",
        description:
          "Embeds a natural-language description with SigLIP2 and returns videos ranked by their best matching frames, grouped into moments.",
        body: z.object({
          query: z.string().trim().min(1).max(300),
          filters: filtersSchema,
          limit: z.number().int().min(1).max(200).default(60),
        }),
        response: { 200: searchResponseSchema },
      },
    },
    async (request) => ({
      success: true as const,
      data: await visualSearchService.search(request.user!.id, {
        query: request.body.query,
        filters: toFilters(request.body.filters),
        limit: request.body.limit,
      }),
    })
  );

  app.post(
    "/similar",
    {
      schema: {
        tags: ["visual-search"],
        summary: "Find moments that look like a frame",
        body: z.object({
          video_id: z.number().int().positive(),
          timestamp_seconds: z.number().min(0),
          include_same_video: z.boolean().default(false),
          filters: filtersSchema,
          limit: z.number().int().min(1).max(200).default(60),
        }),
        response: { 200: searchResponseSchema },
      },
    },
    async (request) => ({
      success: true as const,
      data: await visualSearchService.similar(request.user!.id, {
        videoId: request.body.video_id,
        timestampSeconds: request.body.timestamp_seconds,
        includeSameVideo: request.body.include_same_video,
        filters: toFilters(request.body.filters),
        limit: request.body.limit,
      }),
    })
  );

  app.get(
    "/tags/:tagId/queries",
    {
      schema: {
        tags: ["visual-search"],
        summary: "List a tag's visual descriptions",
        params: tagParams,
        response: { 200: z.object({ success: z.literal(true), data: z.array(queryDtoSchema) }) },
      },
    },
    async (request) => ({
      success: true as const,
      data: await visualSearchService.tagQueries(request.params.tagId),
    })
  );

  app.post(
    "/tags/:tagId/queries",
    {
      schema: {
        tags: ["visual-search"],
        summary: "Save a visual description for a tag",
        params: tagParams,
        body: z.object({ query: z.string().trim().min(1).max(300) }),
        response: { 200: z.object({ success: z.literal(true), data: queryDtoSchema }) },
      },
    },
    async (request) => ({
      success: true as const,
      data: await visualSearchService.addTagQuery(request.params.tagId, request.body.query),
    })
  );

  app.delete(
    "/tags/:tagId/queries/:id",
    {
      schema: {
        tags: ["visual-search"],
        summary: "Remove a tag's visual description",
        params: tagParams.extend({ id: z.coerce.number().int().positive() }),
        response: { 200: z.object({ success: z.literal(true) }) },
      },
    },
    async (request) => {
      await visualSearchService.removeTagQuery(request.params.tagId, request.params.id);
      return { success: true as const };
    }
  );

  app.get(
    "/tags/:tagId/suggestions",
    {
      schema: {
        tags: ["visual-search"],
        summary: "Videos that look like a tag but do not carry it",
        params: tagParams,
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(200).default(60) }),
        response: {
          200: z.object({
            success: z.literal(true),
            data: searchResponseSchema.shape.data.extend({ queries: z.array(queryDtoSchema) }),
          }),
        },
      },
    },
    async (request) => ({
      success: true as const,
      data: await visualSearchService.tagSuggestions(
        request.user!.id,
        request.params.tagId,
        request.query.limit
      ),
    })
  );
}
