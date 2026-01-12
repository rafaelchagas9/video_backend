import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { authenticateUser } from "@/modules/auth/auth.middleware";
import { settingsService } from "./settings.service";
import {
  updateSettingsSchema,
  settingsResponseSchema,
  errorResponseSchema,
} from "./settings.schemas";

export async function settingsRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.addHook("preHandler", authenticateUser);

  app.get(
    "/",
    {
      schema: {
        tags: ["settings"],
        summary: "List app settings",
        description: "Returns all configurable application settings.",
        response: {
          200: settingsResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (_request, reply) => {
      const settings = await settingsService.getAll();

      return reply.send({
        success: true,
        data: settings,
      });
    },
  );

  app.patch(
    "/",
    {
      schema: {
        tags: ["settings"],
        summary: "Update app settings",
        description: "Updates one or more application settings.",
        body: updateSettingsSchema,
        response: {
          200: settingsResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const settings = await settingsService.updateValues(
        request.body.settings,
      );

      return reply.send({
        success: true,
        data: settings,
      });
    },
  );
}
