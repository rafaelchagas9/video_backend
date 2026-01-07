import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { authenticateUser } from "@/modules/auth/auth.middleware";
import { ratingsService } from "./ratings.service";
import {
  idParamSchema,
  updateRatingSchema,
  ratingResponseSchema,
  messageResponseSchema,
  errorResponseSchema,
} from "./ratings.schemas";

export async function ratingsRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // All routes require authentication
  app.addHook("preHandler", authenticateUser);

  // Update rating
  app.patch(
    "/:id",
    {
      schema: {
        tags: ["ratings"],
        summary: "Update a rating",
        description: "Updates an existing rating's score or comment.",
        params: idParamSchema,
        body: updateRatingSchema,
        response: {
          200: ratingResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const rating = await ratingsService.update(
        request.params.id,
        request.body,
      );

      return reply.send({
        success: true,
        data: rating,
        message: "Rating updated successfully",
      });
    },
  );

  // Delete rating
  app.delete(
    "/:id",
    {
      schema: {
        tags: ["ratings"],
        summary: "Delete a rating",
        description: "Permanently deletes a rating.",
        params: idParamSchema,
        response: {
          200: messageResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      await ratingsService.delete(request.params.id);

      return reply.send({
        success: true,
        message: "Rating deleted successfully",
      });
    },
  );
}
