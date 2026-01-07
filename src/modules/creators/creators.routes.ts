import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { authenticateUser } from "@/modules/auth/auth.middleware";
import { creatorsService } from "./creators.service";
import {
  idParamSchema,
  createCreatorSchema,
  updateCreatorSchema,
  creatorResponseSchema,
  creatorListResponseSchema,
  creatorVideosResponseSchema,
  messageResponseSchema,
  errorResponseSchema,
} from "./creators.schemas";

export async function creatorsRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // All routes require authentication
  app.addHook("preHandler", authenticateUser);

  // List all creators
  app.get(
    "/",
    {
      schema: {
        tags: ["creators"],
        summary: "List all creators",
        description: "Returns a list of all creators.",
        response: {
          200: creatorListResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (_request, reply) => {
      const creators = await creatorsService.list();

      return reply.send({
        success: true,
        data: creators,
      });
    },
  );

  // Get creator by ID
  app.get(
    "/:id",
    {
      schema: {
        tags: ["creators"],
        summary: "Get creator by ID",
        description: "Returns details of a specific creator.",
        params: idParamSchema,
        response: {
          200: creatorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const creator = await creatorsService.findById(request.params.id);

      return reply.send({
        success: true,
        data: creator,
      });
    },
  );

  // Create new creator
  app.post(
    "/",
    {
      schema: {
        tags: ["creators"],
        summary: "Create a new creator",
        description: "Creates a new creator with the provided details.",
        body: createCreatorSchema,
        response: {
          201: creatorResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const creator = await creatorsService.create(request.body);

      return reply.status(201).send({
        success: true,
        data: creator,
        message: "Creator created successfully",
      });
    },
  );

  // Update creator
  app.patch(
    "/:id",
    {
      schema: {
        tags: ["creators"],
        summary: "Update a creator",
        description: "Updates an existing creator's details.",
        params: idParamSchema,
        body: updateCreatorSchema,
        response: {
          200: creatorResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const creator = await creatorsService.update(
        request.params.id,
        request.body,
      );

      return reply.send({
        success: true,
        data: creator,
        message: "Creator updated successfully",
      });
    },
  );

  // Delete creator
  app.delete(
    "/:id",
    {
      schema: {
        tags: ["creators"],
        summary: "Delete a creator",
        description: "Permanently deletes a creator.",
        params: idParamSchema,
        response: {
          200: messageResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      await creatorsService.delete(request.params.id);

      return reply.send({
        success: true,
        message: "Creator deleted successfully",
      });
    },
  );

  // Get videos by creator
  app.get(
    "/:id/videos",
    {
      schema: {
        tags: ["creators"],
        summary: "Get videos by creator",
        description: "Returns all videos associated with a creator.",
        params: idParamSchema,
        response: {
          200: creatorVideosResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const videos = await creatorsService.getVideos(request.params.id);

      return reply.send({
        success: true,
        data: videos,
      });
    },
  );
}
