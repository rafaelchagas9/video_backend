import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { authenticateUser } from "@/modules/auth/auth.middleware";
import { searchService } from "./search.service";
import {
  errorResponseSchema,
  searchQuerySchema,
  searchResponseSchema,
} from "./search.schemas";

export async function searchRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.addHook("preHandler", authenticateUser);

  app.get(
    "/",
    {
      schema: {
        tags: ["search"],
        summary: "Search across the media library",
        description:
          "Searches videos and taxonomy entities, returning exact totals for every group.",
        querystring: searchQuerySchema,
        response: {
          200: searchResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await searchService.search(
        request.user!.id,
        request.query.q,
        request.query.limit
      );
      return reply.send(result);
    }
  );
}
