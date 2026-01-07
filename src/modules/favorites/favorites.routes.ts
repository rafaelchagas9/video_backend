import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { authenticateUser } from "@/modules/auth/auth.middleware";
import { favoritesService } from "./favorites.service";
import {
  videoIdParamSchema,
  addFavoriteSchema,
  favoritesListResponseSchema,
  favoriteCheckResponseSchema,
  messageResponseSchema,
  errorResponseSchema,
} from "./favorites.schemas";

export async function favoritesRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // All routes require authentication
  app.addHook("preHandler", authenticateUser);

  // List all favorites
  app.get(
    "/",
    {
      schema: {
        tags: ["favorites"],
        summary: "List favorite videos",
        description: "Returns all videos marked as favorites by the user.",
        response: {
          200: favoritesListResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const favorites = await favoritesService.list(request.user!.id);

      return reply.send({
        success: true,
        data: favorites as any,
      });
    },
  );

  // Add video to favorites
  app.post(
    "/",
    {
      schema: {
        tags: ["favorites"],
        summary: "Add video to favorites",
        description: "Marks a video as a favorite.",
        body: addFavoriteSchema,
        response: {
          201: messageResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      await favoritesService.add(request.user!.id, request.body.video_id);

      return reply.status(201).send({
        success: true,
        message: "Video added to favorites",
      });
    },
  );

  // Remove video from favorites
  app.delete(
    "/:video_id",
    {
      schema: {
        tags: ["favorites"],
        summary: "Remove video from favorites",
        description: "Removes a video from the favorites list.",
        params: videoIdParamSchema,
        response: {
          200: messageResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      await favoritesService.remove(request.user!.id, request.params.video_id);

      return reply.send({
        success: true,
        message: "Video removed from favorites",
      });
    },
  );

  // Check if video is favorited
  app.get(
    "/:video_id/check",
    {
      schema: {
        tags: ["favorites"],
        summary: "Check if video is favorited",
        description: "Checks whether a video is in the user's favorites.",
        params: videoIdParamSchema,
        response: {
          200: favoriteCheckResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const isFavorite = await favoritesService.isFavorite(
        request.user!.id,
        request.params.video_id,
      );

      return reply.send({
        success: true,
        data: { is_favorite: isFavorite },
      });
    },
  );
}
