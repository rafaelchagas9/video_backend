import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { authenticateUser } from "@/modules/auth/auth.middleware";
import { tagsService } from "./tags.service";
import {
  idParamSchema,
  listTagsQuerySchema,
  createTagSchema,
  updateTagSchema,
  tagResponseSchema,
  tagRecordResponseSchema,
  tagListResponseSchema,
  tagSimpleListResponseSchema,
  tagVideosResponseSchema,
  messageResponseSchema,
  errorResponseSchema,
} from "./tags.schemas";

export async function tagsRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // All routes require authentication
  app.addHook("preHandler", authenticateUser);

  // List all tags (optionally as tree with pagination)
  app.get(
    "/",
    {
      schema: {
        tags: ["tags"],
        summary: "List all tags",
        description:
          "Returns tags with pagination and search. Use ?tree=true to get hierarchical structure with pagination at root level.",
        querystring: listTagsQuerySchema,
        response: {
          200: tagListResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await tagsService.list(request.query);
      return reply.send({
        success: true,
        data: result.data,
        pagination: result.pagination,
      });
    },
  );

  // Get tag by ID (with path)
  app.get(
    "/:id",
    {
      schema: {
        tags: ["tags"],
        summary: "Get tag by ID",
        description: "Returns tag details including its hierarchical path.",
        params: idParamSchema,
        response: {
          200: tagResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const tag = await tagsService.findByIdWithPath(request.params.id);

      return reply.send({
        success: true,
        data: tag,
      });
    },
  );

  // Create new tag
  app.post(
    "/",
    {
      schema: {
        tags: ["tags"],
        summary: "Create a tag",
        description: "Creates a new tag. Can be nested under a parent tag.",
        body: createTagSchema,
        response: {
          201: tagRecordResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const tag = await tagsService.create(request.body);

      return reply.status(201).send({
        success: true,
        data: tag,
        message: "Tag created successfully",
      });
    },
  );

  // Update tag
  app.patch(
    "/:id",
    {
      schema: {
        tags: ["tags"],
        summary: "Update a tag",
        description: "Updates tag name, description, or parent.",
        params: idParamSchema,
        body: updateTagSchema,
        response: {
          200: tagRecordResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const tag = await tagsService.update(request.params.id, request.body);

      return reply.send({
        success: true,
        data: tag,
        message: "Tag updated successfully",
      });
    },
  );

  // Delete tag (cascades to children)
  app.delete(
    "/:id",
    {
      schema: {
        tags: ["tags"],
        summary: "Delete a tag",
        description: "Deletes a tag and all its children.",
        params: idParamSchema,
        response: {
          200: messageResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      await tagsService.delete(request.params.id);

      return reply.send({
        success: true,
        message: "Tag deleted successfully",
      });
    },
  );

  // Get child tags
  app.get(
    "/:id/children",
    {
      schema: {
        tags: ["tags"],
        summary: "Get child tags",
        description: "Returns all direct children of a tag.",
        params: idParamSchema,
        response: {
          200: tagSimpleListResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const children = await tagsService.getChildren(request.params.id);

      return reply.send({
        success: true,
        data: children,
      });
    },
  );

  // Get videos with tag
  app.get(
    "/:id/videos",
    {
      schema: {
        tags: ["tags"],
        summary: "Get videos with tag",
        description: "Returns all videos that have this tag.",
        params: idParamSchema,
        response: {
          200: tagVideosResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const videos = await tagsService.getVideos(request.params.id);

      return reply.send({
        success: true,
        data: videos,
      });
    },
  );
}
