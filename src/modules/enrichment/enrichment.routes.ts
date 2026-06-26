import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { authenticateUser } from "@/modules/auth/auth.middleware";
import { enrichmentService } from "./enrichment.service";
import {
  entityParamSchema,
  runEnrichmentBodySchema,
  suggestionIdParamSchema,
  listSuggestionsQuerySchema,
  runResponseSchema,
  runListResponseSchema,
  suggestionResponseSchema,
  suggestionListResponseSchema,
  errorResponseSchema,
} from "./enrichment.schemas";

export async function enrichmentRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.addHook("preHandler", authenticateUser);

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
            body.sources ?? (body.source !== undefined ? [body.source] : undefined),
          search_name: body.search_name,
          limit: body.limit,
        },
      );
      return reply.send({
        success: true,
        data: run,
        message: `Enrichment ${run.status}: ${run.suggestion_count} new suggestions`,
      });
    },
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
        request.params.id,
      );
      return reply.send({ success: true, data: runs });
    },
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
      const suggestions = await enrichmentService.listSuggestions(request.query);
      return reply.send({ success: true, data: suggestions });
    },
  );

  // Accept a suggestion (writes through existing entity writers)
  app.post(
    "/suggestions/:id/accept",
    {
      schema: {
        tags: ["enrichment"],
        summary: "Accept a suggestion",
        description:
          "Applies the suggestion via the existing entity writers and marks it accepted.",
        params: suggestionIdParamSchema,
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
      );
      return reply.send({
        success: true,
        data: suggestion,
        message: "Suggestion accepted",
      });
    },
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
        request.params.id,
      );
      return reply.send({
        success: true,
        data: suggestion,
        message: "Suggestion rejected",
      });
    },
  );
}
