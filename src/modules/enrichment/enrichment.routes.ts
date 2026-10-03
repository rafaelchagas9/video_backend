import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { authenticateUser } from "@/modules/auth/auth.middleware";
import { registerProviderRoutes } from "./enrichment.providers";
import { registerIdentifyRoutes } from "./enrichment.identify.routes";
import { enrichmentService } from "./enrichment.service";
import {
  entityParamSchema,
  runEnrichmentBodySchema,
  suggestionIdParamSchema,
  resolveSuggestionsBodySchema,
  resolveSuggestionsResponseSchema,
  resolutionResponseSchema,
  sceneResetResponseSchema,
  listSuggestionsQuerySchema,
  runResponseSchema,
  runListResponseSchema,
  acceptSuggestionBodySchema,
  suggestionResponseSchema,
  suggestionListResponseSchema,
  errorResponseSchema,
} from "./enrichment.schemas";

export async function enrichmentRoutes(
  fastify: FastifyInstance
): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.addHook("preHandler", authenticateUser);

  registerProviderRoutes(app);
  registerIdentifyRoutes(app);

  // Run discovery for an entity (creator | studio | scene | tag)
  app.post(
    "/:entityType/:id/run",
    {
      schema: {
        tags: ["enrichment"],
        summary: "Run enrichment for an entity",
        description:
          "Calls the enrichment service and stores discovered candidates as pending suggestions.",
        params: entityParamSchema,
        body: runEnrichmentBodySchema,
        response: {
          200: runResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
          502: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const body = request.body ?? {};
      const run = await enrichmentService.runEnrichment(
        request.params.entityType,
        request.params.id,
        {
          sources:
            body.sources ??
            (body.source !== undefined ? [body.source] : undefined),
          search_name: body.search_name,
          limit: body.limit,
          external_ref: body.external_ref,
          scraper_url: body.scraper_url,
          fingerprint: body.fingerprint,
          stash_scene_id: body.stash_scene_id,
          identify_by_hash: body.identify_by_hash,
          scraper_id: body.scraper_id,
        }
      );
      return reply.send({
        success: true,
        data: run,
        message: `Enrichment ${run.status}: ${run.suggestion_count} new suggestions`,
      });
    }
  );

  // List enrichment runs for an entity
  app.get(
    "/:entityType/:id/runs",
    {
      schema: {
        tags: ["enrichment"],
        summary: "List enrichment runs for an entity",
        params: entityParamSchema,
        response: {
          200: runListResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const runs = await enrichmentService.listRuns(
        request.params.entityType,
        request.params.id
      );
      return reply.send({ success: true, data: runs });
    }
  );

  // List suggestions (filterable)
  app.get(
    "/suggestions",
    {
      schema: {
        tags: ["enrichment"],
        summary: "List enrichment suggestions",
        description:
          "Returns suggestions filtered by entity, status, and/or type, ranked by face-match then source confidence.",
        querystring: listSuggestionsQuerySchema,
        response: {
          200: suggestionListResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const suggestions = await enrichmentService.listSuggestions(
        request.query
      );
      return reply.send({ success: true, data: suggestions });
    }
  );

  // What each pending performer / studio / tag proposal would link to (read-only).
  app.get(
    "/:entityType/:id/resolution",
    {
      schema: {
        tags: ["enrichment"],
        summary: "Preview which library entities related proposals resolve to",
        description:
          "For each pending performer, studio and tag proposal: the existing creator, studio or tag " +
          "accepting it would link (by external id, name ignoring case, or alias), or null when " +
          "accepting would create a new one.",
        params: entityParamSchema,
        response: {
          200: resolutionResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const data = await enrichmentService.previewResolution(
        request.params.entityType,
        request.params.id
      );
      return reply.send({ success: true, data });
    }
  );

  // Decide many suggestions in one request — a whole review pass at once.
  app.post(
    "/suggestions/resolve",
    {
      schema: {
        tags: ["enrichment"],
        summary: "Accept and reject suggestions in bulk",
        description:
          "Rejects are applied first, then accepts run through the entity writers. " +
          "A failing accept is reported in `failed` and leaves that suggestion pending.",
        body: resolveSuggestionsBodySchema,
        response: {
          200: resolveSuggestionsResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await enrichmentService.resolveSuggestions(request.body);
      return reply.send({ success: true, data: result });
    }
  );

  // Undo a scene's enrichment: applied metadata, links and every proposal.
  app.post(
    "/scene/:id/reset",
    {
      schema: {
        tags: ["enrichment"],
        summary: "Reset a scene's enrichment",
        description:
          "Removes what accepted proposals wrote to the scene (title and synopsis when they still match, " +
          "release date, code, director, cover, source ids, and the cast, studio and tag links they made) " +
          "and deletes all of the scene's proposals and runs, so a new scan starts from scratch. " +
          "Creators, studios and tags that enrichment created stay in the library.",
        params: z.object({ id: z.coerce.number().int().positive() }),
        response: {
          200: sceneResetResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const data = await enrichmentService.resetScene(request.params.id);
      return reply.send({
        success: true,
        data,
        message: `Cleared ${data.suggestions_cleared} proposals and ${data.links_removed} links`,
      });
    }
  );

  // Accept a suggestion (writes through existing entity writers)
  app.post(
    "/suggestions/:id/accept",
    {
      schema: {
        tags: ["enrichment"],
        summary: "Accept a suggestion",
        description:
          "Applies the suggestion via the existing entity writers and marks it accepted. " +
          "A performer, studio or tag whose name matches several library entities, or a " +
          "single-name performer, needs `target_id` (link that entity) or `create: true`.",
        params: suggestionIdParamSchema,
        body: acceptSuggestionBodySchema,
        response: {
          200: suggestionResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const suggestion = await enrichmentService.acceptSuggestion(
        request.params.id,
        request.body ?? undefined
      );
      return reply.send({
        success: true,
        data: suggestion,
        message: "Suggestion accepted",
      });
    }
  );

  // Reject a suggestion
  app.post(
    "/suggestions/:id/reject",
    {
      schema: {
        tags: ["enrichment"],
        summary: "Reject a suggestion",
        params: suggestionIdParamSchema,
        response: {
          200: suggestionResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const suggestion = await enrichmentService.rejectSuggestion(
        request.params.id
      );
      return reply.send({
        success: true,
        data: suggestion,
        message: "Suggestion rejected",
      });
    }
  );
}
