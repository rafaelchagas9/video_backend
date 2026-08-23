import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { authenticateUser } from "@/modules/auth/auth.middleware";
import { videoCollectionsService } from "./video-collections.service";
import {
  createVideoCollectionEntrySchema,
  createVideoCollectionSchema,
  errorResponseSchema,
  idParamSchema,
  messageResponseSchema,
  reorderVideoCollectionEntriesSchema,
  videoCollectionEntriesResponseSchema,
  videoCollectionResponseSchema,
  videoCollectionsListResponseSchema,
  videoIdParamSchema,
  videoCollectionQuerySchema,
} from "./video-collections.schemas";
import { updateVideoCollectionSchema } from "./video-collections.types";

export async function videoCollectionsRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.addHook("preHandler", authenticateUser);

  app.get(
    "/",
    {
      schema: {
        tags: ["video-collections"],
        summary: "List video collections",
        description: "Returns all configured video collections.",
        querystring: videoCollectionQuerySchema,
        response: {
          200: videoCollectionsListResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const collections = await videoCollectionsService.list(
        request.user!.id,
        request.query.include ?? [],
      );
      return reply.send({
        success: true,
        data: collections,
      });
    },
  );

  app.post(
    "/",
    {
      schema: {
        tags: ["video-collections"],
        summary: "Create a video collection",
        description: "Creates a new canonical video collection.",
        body: createVideoCollectionSchema,
        response: {
          201: videoCollectionResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const collection = await videoCollectionsService.create(
        request.body,
        request.user!.id,
      );
      return reply.status(201).send({
        success: true,
        data: collection,
        message: "Video collection created successfully",
      });
    },
  );

  app.get(
    "/:id",
    {
      schema: {
        tags: ["video-collections"],
        summary: "Get video collection by ID",
        description: "Returns one video collection.",
        params: idParamSchema,
        querystring: videoCollectionQuerySchema,
        response: {
          200: videoCollectionResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const collection = await videoCollectionsService.findById(
        request.params.id,
        request.user!.id,
        request.query.include ?? [],
      );
      return reply.send({
        success: true,
        data: collection,
      });
    },
  );

  app.patch(
    "/:id",
    {
      schema: {
        tags: ["video-collections"],
        summary: "Update a video collection",
        description:
          "Updates collection metadata. artwork_source_video_id must reference a video that already belongs to this collection.",
        params: idParamSchema,
        body: updateVideoCollectionSchema,
        response: {
          200: videoCollectionResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const collection = await videoCollectionsService.update(
        request.params.id,
        request.body,
        request.user!.id,
      );
      return reply.send({
        success: true,
        data: collection,
        message: "Video collection updated successfully",
      });
    },
  );

  app.delete(
    "/:id",
    {
      schema: {
        tags: ["video-collections"],
        summary: "Delete a video collection",
        description: "Deletes a collection and all of its entries.",
        params: idParamSchema,
        response: {
          200: messageResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      await videoCollectionsService.delete(request.params.id);
      return reply.send({
        success: true,
        message: "Video collection deleted successfully",
      });
    },
  );

  app.get(
    "/:id/entries",
    {
      schema: {
        tags: ["video-collections"],
        summary: "List video collection entries",
        description: "Returns ordered entries for a collection.",
        params: idParamSchema,
        response: {
          200: videoCollectionEntriesResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const entries = await videoCollectionsService.listEntries(
        request.params.id,
        request.user!.id,
      );
      return reply.send({
        success: true,
        data: entries,
      });
    },
  );

  app.post(
    "/:id/entries",
    {
      schema: {
        tags: ["video-collections"],
        summary: "Add a video to a collection",
        description: "Creates one ordered collection entry for a video.",
        params: idParamSchema,
        body: createVideoCollectionEntrySchema,
        response: {
          201: videoCollectionEntriesResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const entry = await videoCollectionsService.addEntry(
        request.params.id,
        request.body,
      );
      return reply.status(201).send({
        success: true,
        data: [entry],
      });
    },
  );

  app.patch(
    "/:id/entries/reorder",
    {
      schema: {
        tags: ["video-collections"],
        summary: "Reorder video collection entries",
        description:
          "Updates sequence and episodic coordinates for existing entries.",
        params: idParamSchema,
        body: reorderVideoCollectionEntriesSchema,
        response: {
          200: videoCollectionEntriesResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const entries = await videoCollectionsService.reorderEntries(
        request.params.id,
        request.body,
      );
      return reply.send({
        success: true,
        data: entries,
      });
    },
  );

  app.delete(
    "/:id/entries/:video_id",
    {
      schema: {
        tags: ["video-collections"],
        summary: "Delete a video collection entry",
        description: "Removes a video from a collection.",
        params: videoIdParamSchema,
        response: {
          200: messageResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      await videoCollectionsService.removeEntry(
        request.params.id,
        request.params.video_id,
      );
      return reply.send({
        success: true,
        message: "Collection entry removed successfully",
      });
    },
  );
}
