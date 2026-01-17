import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { authenticateUser } from "@/modules/auth/auth.middleware";
import { storageStatsService } from "./stats.storage.service";
import { libraryStatsService } from "./stats.library.service";
import { contentStatsService } from "./stats.content.service";
import { usageStatsService } from "./stats.usage.service";
import {
  historyQuerySchema,
  errorResponseSchema,
  storageCurrentResponseSchema,
  storageHistoryResponseSchema,
  storageSnapshotResponseSchema,
  libraryCurrentResponseSchema,
  libraryHistoryResponseSchema,
  librarySnapshotResponseSchema,
  contentCurrentResponseSchema,
  contentHistoryResponseSchema,
  contentSnapshotResponseSchema,
  usageCurrentResponseSchema,
  usageHistoryResponseSchema,
  usageSnapshotResponseSchema,
  allSnapshotsResponseSchema,
} from "./stats.schemas";

export async function statsRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // All routes require authentication
  app.addHook("preHandler", authenticateUser);

  // ============================================================
  // STORAGE STATS
  // ============================================================

  // Get current storage stats (real-time)
  app.get(
    "/storage",
    {
      schema: {
        tags: ["stats"],
        summary: "Get current storage statistics",
        description:
          "Returns real-time storage statistics including video sizes, thumbnails, storyboards, and per-directory breakdown.",
        response: {
          200: storageCurrentResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (_request, reply) => {
      const data = await storageStatsService.getCurrentStorageStats();

      return reply.send({
        success: true,
        data,
      });
    },
  );

  // Get storage history
  app.get(
    "/storage/history",
    {
      schema: {
        tags: ["stats"],
        summary: "Get storage statistics history",
        description:
          "Returns historical storage snapshots for graphing storage usage over time.",
        querystring: historyQuerySchema,
        response: {
          200: storageHistoryResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { days, limit } = request.query;
      const data = await storageStatsService.getStorageHistory(days, limit);

      return reply.send({
        success: true,
        data,
      });
    },
  );

  // Create storage snapshot manually
  app.post(
    "/storage/snapshot",
    {
      schema: {
        tags: ["stats"],
        summary: "Create storage snapshot",
        description: "Manually triggers a storage statistics snapshot.",
        response: {
          201: storageSnapshotResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (_request, reply) => {
      const data = await storageStatsService.createStorageSnapshot();

      return reply.status(201).send({
        success: true,
        data,
        message: "Storage snapshot created",
      });
    },
  );

  // ============================================================
  // LIBRARY STATS
  // ============================================================

  // Get current library stats
  app.get(
    "/library",
    {
      schema: {
        tags: ["stats"],
        summary: "Get current library statistics",
        description:
          "Returns real-time library statistics including video counts, resolution breakdown, and codec breakdown.",
        response: {
          200: libraryCurrentResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (_request, reply) => {
      const data = await libraryStatsService.getCurrentLibraryStats();

      return reply.send({
        success: true,
        data,
      });
    },
  );

  // Get library history
  app.get(
    "/library/history",
    {
      schema: {
        tags: ["stats"],
        summary: "Get library statistics history",
        description: "Returns historical library snapshots for graphing.",
        querystring: historyQuerySchema,
        response: {
          200: libraryHistoryResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { days, limit } = request.query;
      const data = await libraryStatsService.getLibraryHistory(days, limit);

      return reply.send({
        success: true,
        data,
      });
    },
  );

  // Create library snapshot manually
  app.post(
    "/library/snapshot",
    {
      schema: {
        tags: ["stats"],
        summary: "Create library snapshot",
        description: "Manually triggers a library statistics snapshot.",
        response: {
          201: librarySnapshotResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (_request, reply) => {
      const data = await libraryStatsService.createLibrarySnapshot();

      return reply.status(201).send({
        success: true,
        data,
        message: "Library snapshot created",
      });
    },
  );

  // ============================================================
  // CONTENT STATS
  // ============================================================

  // Get current content stats
  app.get(
    "/content",
    {
      schema: {
        tags: ["stats"],
        summary: "Get current content organization statistics",
        description:
          "Returns statistics about content organization including videos without tags, creators, ratings, etc.",
        response: {
          200: contentCurrentResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (_request, reply) => {
      const data = await contentStatsService.getCurrentContentStats();

      return reply.send({
        success: true,
        data,
      });
    },
  );

  // Get content history
  app.get(
    "/content/history",
    {
      schema: {
        tags: ["stats"],
        summary: "Get content statistics history",
        description: "Returns historical content organization snapshots.",
        querystring: historyQuerySchema,
        response: {
          200: contentHistoryResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { days, limit } = request.query;
      const data = await contentStatsService.getContentHistory(days, limit);

      return reply.send({
        success: true,
        data,
      });
    },
  );

  // Create content snapshot manually
  app.post(
    "/content/snapshot",
    {
      schema: {
        tags: ["stats"],
        summary: "Create content snapshot",
        description: "Manually triggers a content statistics snapshot.",
        response: {
          201: contentSnapshotResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (_request, reply) => {
      const data = await contentStatsService.createContentSnapshot();

      return reply.status(201).send({
        success: true,
        data,
        message: "Content snapshot created",
      });
    },
  );

  // ============================================================
  // USAGE STATS
  // ============================================================

  // Get current usage stats
  app.get(
    "/usage",
    {
      schema: {
        tags: ["stats"],
        summary: "Get current usage/watch statistics",
        description:
          "Returns watch/usage statistics including total watch time, top watched videos, and activity by hour.",
        response: {
          200: usageCurrentResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (_request, reply) => {
      const data = await usageStatsService.getCurrentUsageStats();

      return reply.send({
        success: true,
        data,
      });
    },
  );

  // Get usage history
  app.get(
    "/usage/history",
    {
      schema: {
        tags: ["stats"],
        summary: "Get usage statistics history",
        description: "Returns historical usage/watch snapshots.",
        querystring: historyQuerySchema,
        response: {
          200: usageHistoryResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { days, limit } = request.query;
      const data = await usageStatsService.getUsageHistory(days, limit);

      return reply.send({
        success: true,
        data,
      });
    },
  );

  // Create usage snapshot manually
  app.post(
    "/usage/snapshot",
    {
      schema: {
        tags: ["stats"],
        summary: "Create usage snapshot",
        description: "Manually triggers a usage statistics snapshot.",
        response: {
          201: usageSnapshotResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (_request, reply) => {
      const data = await usageStatsService.createUsageSnapshot();

      return reply.status(201).send({
        success: true,
        data,
        message: "Usage snapshot created",
      });
    },
  );

  // ============================================================
  // COMBINED OPERATIONS
  // ============================================================

  // Create all snapshots at once
  app.post(
    "/snapshot",
    {
      schema: {
        tags: ["stats"],
        summary: "Create all snapshots",
        description:
          "Manually triggers snapshots for all statistics types (storage, library, content, usage).",
        response: {
          201: allSnapshotsResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (_request, reply) => {
      const storage = await storageStatsService.createStorageSnapshot();
      const library = await libraryStatsService.createLibrarySnapshot();
      const content = await contentStatsService.createContentSnapshot();
      const usage = await usageStatsService.createUsageSnapshot();

      return reply.status(201).send({
        success: true,
        data: {
          storage,
          library,
          content,
          usage,
        },
        message: "All snapshots created",
      });
    },
  );
}
