import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { authenticateUser } from "@/modules/auth/auth.middleware";
import { directoriesService } from "./directories.service";
import { watcherService } from "./watcher.service";
import { env } from "@/config/env";
import { directoriesDemoService } from "./directories.demo.service";
import { directoryScansService } from "./directory-scans.service";
import { schedulerService } from "@/modules/scheduler/scheduler.service";
import {
  idParamSchema,
  createDirectorySchema,
  updateDirectorySchema,
  directoryResponseSchema,
  directoryListResponseSchema,
  directoryStatsResponseSchema,
  messageResponseSchema,
  errorResponseSchema,
  scanIdParamSchema,
  scanPaginationSchema,
  scanRunResponseSchema,
  scanStartedResponseSchema,
  scanRunListResponseSchema,
  schedulerStatusResponseSchema,
} from "./directories.schemas";

export async function directoriesRoutes(
  fastify: FastifyInstance
): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // All routes require authentication
  app.addHook("preHandler", authenticateUser);

  app.get(
    "/scheduler/status",
    {
      schema: {
        tags: ["directories"],
        summary: "Get directory scheduler status",
        response: {
          200: schedulerStatusResponseSchema,
          401: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (_request, reply) => {
      const status = schedulerService.getStatus();
      return reply.send({
        success: true,
        data: {
          is_running: status.isRunning,
          scheduled_directories: status.scheduledDirectories,
          schedules: status.schedules.map((schedule) => ({
            directory_id: schedule.directoryId,
            interval_minutes: schedule.intervalMinutes,
          })),
          system_tasks: status.systemTasks.map((task) => ({
            name: task.name,
            cron_expression: task.cronExpression,
          })),
        },
      });
    }
  );

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
        "Directory registered, triggering initial scan"
      );

      // Trigger initial scan
      const scan = env.DEMO_MODE
        ? directoriesDemoService.startScan(directory.id).completion
        : watcherService.scanDirectory(directory.id);
      scan.catch((error) => {
        fastify.log.error(
          { error, directoryId: directory.id },
          "Failed to trigger initial directory scan"
        );
      });

      return reply.status(201).send({
        success: true,
        data: directory,
        message: "Directory registered successfully. Scanning started.",
      });
    }
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
    }
  );

  // Get directory by ID
  app.get(
    "/:id/scans",
    {
      schema: {
        tags: ["directories"],
        summary: "List directory scan runs",
        params: idParamSchema,
        querystring: scanPaginationSchema,
        response: {
          200: scanRunListResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      await directoriesService.findById(request.params.id);
      const result = await directoryScansService.list(
        request.params.id,
        request.query.page,
        request.query.limit
      );
      return reply.send({ success: true, ...result });
    }
  );

  app.get(
    "/:id/scans/:scanId",
    {
      schema: {
        tags: ["directories"],
        summary: "Get a directory scan run",
        params: scanIdParamSchema,
        response: {
          200: scanRunResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const run = await directoryScansService.findById(
        request.params.id,
        request.params.scanId
      );
      return reply.send({ success: true, data: run });
    }
  );

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
    }
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
        request.body
      );

      return reply.send({
        success: true,
        data: directory,
        message: "Directory updated successfully",
      });
    }
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
    }
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
          202: scanStartedResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const directory = await directoriesService.findById(request.params.id); // Ensure exists

      fastify.log.info(
        {
          directoryId: request.params.id,
          path: directory.path,
          triggeredBy: "manual",
        },
        "Manual scan triggered by user"
      );

      const { run, completion } = env.DEMO_MODE
        ? directoriesDemoService.startScan(request.params.id)
        : await watcherService.startScan(request.params.id);
      completion.catch((error) => {
        fastify.log.error(
          { error, directoryId: request.params.id },
          "Directory scan failed"
        );
      });

      return reply
        .header(
          "Location",
          `/api/directories/${request.params.id}/scans/${run.id}`
        )
        .status(202)
        .send({
          success: true,
          data: run,
        });
    }
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
    }
  );
}
