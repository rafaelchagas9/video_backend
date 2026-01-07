import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { authenticateUser } from "@/modules/auth/auth.middleware";
import { bookmarksService } from "./bookmarks.service";
import {
  idParamSchema,
  updateBookmarkSchema,
  bookmarkResponseSchema,
  messageResponseSchema,
  errorResponseSchema,
} from "./bookmarks.schemas";

export async function bookmarksRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // All routes require authentication
  app.addHook("preHandler", authenticateUser);

  // Update bookmark
  app.patch(
    "/:id",
    {
      schema: {
        tags: ["bookmarks"],
        summary: "Update a bookmark",
        description: "Updates an existing bookmark's details.",
        params: idParamSchema,
        body: updateBookmarkSchema,
        response: {
          200: bookmarkResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const bookmark = await bookmarksService.update(
        request.params.id,
        request.user!.id,
        request.body,
      );

      return reply.send({
        success: true,
        data: bookmark,
        message: "Bookmark updated successfully",
      });
    },
  );

  // Delete bookmark
  app.delete(
    "/:id",
    {
      schema: {
        tags: ["bookmarks"],
        summary: "Delete a bookmark",
        description: "Permanently deletes a bookmark.",
        params: idParamSchema,
        response: {
          200: messageResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      await bookmarksService.delete(request.params.id, request.user!.id);

      return reply.send({
        success: true,
        message: "Bookmark deleted successfully",
      });
    },
  );
}
