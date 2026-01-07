import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { authenticateUser } from "@/modules/auth/auth.middleware";
import { directoriesService } from "./directories.service";
import { watcherService } from "./watcher.service";
import {
  idParamSchema,
  createDirectorySchema,
  updateDirectorySchema,
  directoryResponseSchema,
  directoryListResponseSchema,
  directoryStatsResponseSchema,
  messageResponseSchema,
  errorResponseSchema,
} from "./directories.schemas";

export async function directoriesRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // All routes require authentication
  app.addHook("preHandler", authenticateUser);

  // Create directory
  app.post(
    "/",
    {
      schema: {
        tags: ["directories"],
        summary: "Register a directory",
        description:
          "Registers a new directory to scan for videos. Triggers an initial scan.",
        body: createDirectorySchema,
        response: {
          201: directoryResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const directory = await directoriesService.create(request.body);

      fastify.log.info(
        { directoryId: directory.id, path: directory.path },
        "Directory registered, triggering initial scan",
      );

      // Trigger initial scan
      watcherService.scanDirectory(directory.id).catch((error) => {
        fastify.log.error(
          { error, directoryId: directory.id },
          "Failed to trigger initial directory scan",
        );
      });

      return reply.status(201).send({
        success: true,
        data: directory,
        message: "Directory registered successfully. Scanning started.",
      });
    },
  );

  // List all directories
  app.get(
    "/",
    {
      schema: {
        tags: ["directories"],
        summary: "List all directories",
        description: "Returns a list of all registered directories.",
        response: {
          200: directoryListResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (_request, reply) => {
      const directories = await directoriesService.findAll();

      return reply.send({
        success: true,
        data: directories,
      });
    },
  );

  // Get directory by ID
  app.get(
    "/:id",
    {
      schema: {
        tags: ["directories"],
        summary: "Get directory by ID",
        description: "Returns details of a specific directory.",
        params: idParamSchema,
        response: {
          200: directoryResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const directory = await directoriesService.findById(request.params.id);

      return reply.send({
        success: true,
        data: directory,
      });
    },
  );

  // Update directory
  app.patch(
    "/:id",
    {
      schema: {
        tags: ["directories"],
        summary: "Update directory settings",
        description: "Updates directory settings like auto-scan interval.",
        params: idParamSchema,
        body: updateDirectorySchema,
        response: {
          200: directoryResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const directory = await directoriesService.update(
        request.params.id,
        request.body,
      );

      return reply.send({
        success: true,
        data: directory,
        message: "Directory updated successfully",
      });
    },
  );

  // Delete directory
  app.delete(
    "/:id",
    {
      schema: {
        tags: ["directories"],
        summary: "Remove a directory",
        description:
          "Removes a directory from monitoring. Does not delete files.",
        params: idParamSchema,
        response: {
          200: messageResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      await directoriesService.delete(request.params.id);

      return reply.send({
        success: true,
        message: "Directory removed successfully",
      });
    },
  );

  // Trigger manual scan
  app.post(
    "/:id/scan",
    {
      schema: {
        tags: ["directories"],
        summary: "Trigger manual scan",
        description:
          "Manually triggers a scan of the directory for new videos.",
        params: idParamSchema,
        response: {
          200: messageResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const directory = await directoriesService.findById(request.params.id); // Ensure exists

      fastify.log.info(
        { directoryId: request.params.id, path: directory.path, triggeredBy: "manual" },
        "Manual scan triggered by user",
      );

      // Trigger scan asynchronously
      watcherService.scanDirectory(request.params.id).catch((error) => {
        fastify.log.error(
          { error, directoryId: request.params.id },
          "Directory scan failed",
        );
      });

      return reply.send({
        success: true,
        message: "Directory scan started",
      });
    },
  );

  // Get directory stats
  app.get(
    "/:id/stats",
    {
      schema: {
        tags: ["directories"],
        summary: "Get directory statistics",
        description: "Returns statistics about videos in the directory.",
        params: idParamSchema,
        response: {
          200: directoryStatsResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const stats = await directoriesService.getStats(request.params.id);

      return reply.send({
        success: true,
        data: stats,
      });
    },
  );
}
