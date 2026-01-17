import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { authenticateUser } from "@/modules/auth/auth.middleware";
import { taggingRulesService } from "./tagging-rules.service";
import {
  idParamSchema,
  listQuerySchema,
  createTaggingRuleSchema,
  updateTaggingRuleSchema,
  bulkDeleteSchema,
  bulkDeleteResponseSchema,
  testRuleSchema,
  testRuleResponseSchema,
  applyRulesSchema,
  applyRulesResponseSchema,
  taggingRuleResponseSchema,
  taggingRuleListResponseSchema,
  messageResponseSchema,
  errorResponseSchema,
} from "./tagging-rules.schemas";

export async function taggingRulesRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.addHook("preHandler", authenticateUser);

  app.get(
    "/",
    {
      schema: {
        tags: ["tagging-rules"],
        summary: "List tagging rules",
        description:
          "Returns all tagging rules. Use include_disabled=true to see disabled rules.",
        querystring: listQuerySchema,
        response: {
          200: taggingRuleListResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { include_disabled } = request.query;

      const rules = await taggingRulesService.list(include_disabled);

      return reply.send({
        success: true,
        data: rules,
      });
    },
  );

  app.get(
    "/:id",
    {
      schema: {
        tags: ["tagging-rules"],
        summary: "Get tagging rule by ID",
        params: idParamSchema,
        response: {
          200: taggingRuleResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const rule = await taggingRulesService.findById(request.params.id);

      return reply.send({
        success: true,
        data: rule,
      });
    },
  );

  app.post(
    "/",
    {
      schema: {
        tags: ["tagging-rules"],
        summary: "Create tagging rule",
        description: "Creates a new tagging rule with conditions and actions.",
        body: createTaggingRuleSchema,
        response: {
          201: taggingRuleResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const rule = await taggingRulesService.create(request.body);

      return reply.status(201).send({
        success: true,
        data: rule,
        message: "Tagging rule created successfully",
      });
    },
  );

  app.patch(
    "/:id",
    {
      schema: {
        tags: ["tagging-rules"],
        summary: "Update tagging rule",
        params: idParamSchema,
        body: updateTaggingRuleSchema,
        response: {
          200: taggingRuleResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const rule = await taggingRulesService.update(
        request.params.id,
        request.body,
      );

      return reply.send({
        success: true,
        data: rule,
        message: "Tagging rule updated successfully",
      });
    },
  );

  app.delete(
    "/:id",
    {
      schema: {
        tags: ["tagging-rules"],
        summary: "Delete tagging rule",
        params: idParamSchema,
        response: {
          200: messageResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      await taggingRulesService.delete(request.params.id);

      return reply.send({
        success: true,
        message: "Tagging rule deleted successfully",
      });
    },
  );

  app.post(
    "/bulk/delete",
    {
      schema: {
        tags: ["tagging-rules"],
        summary: "Bulk delete tagging rules",
        body: bulkDeleteSchema,
        response: {
          200: bulkDeleteResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { ids } = request.body;

      const result = await taggingRulesService.bulkDelete(ids);

      return reply.send({
        success: true,
        data: { deleted: result.deleted },
        message: `Deleted ${result.deleted} tagging rule(s)`,
      });
    },
  );

  app.post(
    "/:id/test",
    {
      schema: {
        tags: ["tagging-rules"],
        summary: "Test tagging rule",
        description:
          "Tests a tagging rule against a sample of videos to see which ones match.",
        params: idParamSchema,
        querystring: testRuleSchema,
        response: {
          200: testRuleResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await taggingRulesService.testRule(
        request.params.id,
        request.query.limit,
      );

      return reply.send({
        success: true,
        data: {
          matched: result.matched,
          sample_matches: result.sample_matches,
        },
      });
    },
  );

  app.post(
    "/apply",
    {
      schema: {
        tags: ["tagging-rules"],
        summary: "Apply tagging rules",
        description:
          "Applies all enabled tagging rules to videos. Use dry_run=true to preview without applying changes.",
        body: applyRulesSchema,
        response: {
          200: applyRulesResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await taggingRulesService.applyRules(request.body);

      return reply.send({
        success: true,
        data: {
          processed: result.processed,
          tagged: result.tagged,
          errors: result.errors,
          details: result.details,
        },
      });
    },
  );
}
