import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { authenticateUser } from "@/modules/auth/auth.middleware";
import { bookmarkCategoriesService } from "./bookmark-categories.service";
import {
  bookmarkCategoriesResponseSchema,
  bookmarkCategoryResponseSchema,
  createBookmarkCategorySchema,
  errorResponseSchema,
  idParamSchema,
  messageResponseSchema,
  updateBookmarkCategorySchema,
} from "./bookmarks.schemas";

export async function bookmarkCategoriesRoutes(
  fastify: FastifyInstance
): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.addHook("preHandler", authenticateUser);

  app.get(
    "/",
    {
      schema: {
        tags: ["bookmark-categories"],
        summary: "List bookmark categories",
        response: {
          200: bookmarkCategoriesResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request, reply) =>
      reply.send({
        success: true,
        data: await bookmarkCategoriesService.list(request.user!.id),
      })
  );

  app.post(
    "/",
    {
      schema: {
        tags: ["bookmark-categories"],
        summary: "Create a custom bookmark category",
        body: createBookmarkCategorySchema,
        response: {
          201: bookmarkCategoryResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const category = await bookmarkCategoriesService.create(
        request.user!.id,
        request.body
      );
      return reply.status(201).send({
        success: true,
        data: category,
        message: "Bookmark category created successfully",
      });
    }
  );

  app.patch(
    "/:id",
    {
      schema: {
        tags: ["bookmark-categories"],
        summary: "Rename an owned custom bookmark category",
        params: idParamSchema,
        body: updateBookmarkCategorySchema,
        response: {
          200: bookmarkCategoryResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const category = await bookmarkCategoriesService.update(
        request.params.id,
        request.user!.id,
        request.body
      );
      return reply.send({
        success: true,
        data: category,
        message: "Bookmark category updated successfully",
      });
    }
  );

  app.delete(
    "/:id",
    {
      schema: {
        tags: ["bookmark-categories"],
        summary: "Delete an owned custom bookmark category",
        params: idParamSchema,
        response: {
          200: messageResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      await bookmarkCategoriesService.delete(
        request.params.id,
        request.user!.id
      );
      return reply.send({
        success: true,
        message: "Bookmark category deleted successfully",
      });
    }
  );
}
