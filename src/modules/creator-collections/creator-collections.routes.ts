import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { authenticateUser } from "@/modules/auth/auth.middleware";
import { creatorCollectionsService } from "./creator-collections.service";
import {
  collectionInput,
  collectionDocument,
} from "./creator-collections.domain";
export async function creatorCollectionsRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.addHook("preHandler", authenticateUser);
  const params = z.object({ creatorId: z.coerce.number().int().positive() });
  const response = {
    200: z.object({ success: z.literal(true), data: collectionDocument }),
  };
  app.get(
    "/:creatorId",
    { schema: { params, response, tags: ["creators"] } },
    async (request) => ({
      success: true as const,
      data: await creatorCollectionsService.list(request.params.creatorId),
    })
  );
  app.post(
    "/:creatorId",
    {
      schema: {
        params,
        body: collectionInput.extend({
          revision: z.number().int().nonnegative(),
        }),
        response,
        tags: ["creators"],
      },
    },
    async (request) => ({
      success: true as const,
      data: await creatorCollectionsService.save(
        request.params.creatorId,
        request.body,
        request.body.revision
      ),
    })
  );
  app.patch(
    "/:creatorId/:id",
    {
      schema: {
        params: params.extend({ id: z.string().uuid() }),
        body: collectionInput.extend({
          revision: z.number().int().nonnegative(),
        }),
        response,
        tags: ["creators"],
      },
    },
    async (request) => ({
      success: true as const,
      data: await creatorCollectionsService.save(
        request.params.creatorId,
        request.body,
        request.body.revision,
        request.params.id
      ),
    })
  );
  app.delete(
    "/:creatorId/:id",
    {
      schema: {
        params: params.extend({ id: z.string().uuid() }),
        querystring: z.object({
          revision: z.coerce.number().int().nonnegative(),
        }),
        response,
        tags: ["creators"],
      },
    },
    async (request) => ({
      success: true as const,
      data: await creatorCollectionsService.remove(
        request.params.creatorId,
        request.query.revision,
        request.params.id
      ),
    })
  );
}
