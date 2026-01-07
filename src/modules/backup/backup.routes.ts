import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { authenticateUser } from "@/modules/auth/auth.middleware";
import { backupService } from "./backup.service";
import {
  filenameParamSchema,
  backupCreatedResponseSchema,
  backupListResponseSchema,
  messageResponseSchema,
  errorResponseSchema,
} from "./backup.schemas";

export async function backupRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // All routes require authentication
  app.addHook("preHandler", authenticateUser);

  // Create a new backup
  app.post(
    "/",
    {
      schema: {
        tags: ["backup"],
        summary: "Create a database backup",
        description: "Creates a new backup of the SQLite database.",
        response: {
          201: backupCreatedResponseSchema,
          401: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (_request, reply) => {
      const backup = await backupService.createBackup();

      return reply.status(201).send({
        success: true,
        data: backup,
        message: "Backup created successfully",
      });
    },
  );

  // List all backups
  app.get(
    "/",
    {
      schema: {
        tags: ["backup"],
        summary: "List all backups",
        description: "Returns a list of all available database backups.",
        response: {
          200: backupListResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (_request, reply) => {
      const backups = backupService.listBackups();

      return reply.send({
        success: true,
        data: backups,
      });
    },
  );

  // Export database as JSON (uses fastify directly for binary response)
  fastify.get(
    "/export",
    {
      schema: {
        tags: ["backup"],
        summary: "Export database as JSON",
        description: "Exports all database tables as a downloadable JSON file.",
      },
    },
    async (_request, reply) => {
      const exportData = backupService.exportToJson();

      return reply
        .header("Content-Type", "application/json")
        .header(
          "Content-Disposition",
          `attachment; filename="export-${new Date().toISOString().split("T")[0]}.json"`,
        )
        .send(exportData);
    },
  );

  // Restore from backup
  app.post(
    "/:filename/restore",
    {
      schema: {
        tags: ["backup"],
        summary: "Restore from backup",
        description: "Restores the database from a specified backup file.",
        params: filenameParamSchema,
        response: {
          200: messageResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      await backupService.restoreBackup(request.params.filename);

      return reply.send({
        success: true,
        message: "Database restored successfully",
      });
    },
  );

  // Delete a backup
  app.delete(
    "/:filename",
    {
      schema: {
        tags: ["backup"],
        summary: "Delete a backup",
        description: "Permanently deletes a backup file.",
        params: filenameParamSchema,
        response: {
          200: messageResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      backupService.deleteBackup(request.params.filename);

      return reply.send({
        success: true,
        message: "Backup deleted successfully",
      });
    },
  );
}
