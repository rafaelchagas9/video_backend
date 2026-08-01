import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { authenticateUser } from "@/modules/auth/auth.middleware";
import { markRouteDeprecated } from "@/utils/api-deprecation";
import { storageStatsService } from "./stats.storage.service";
import { libraryStatsService } from "./stats.library.service";
import { contentStatsService } from "./stats.content.service";
import { usageStatsService } from "./stats.usage.service";
import { statsDemoService } from "./stats.demo.service";
import { env } from "@/config/env";
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

type HistoryQuery = { days: number; limit: number };

const storageStats = () =>
  env.DEMO_MODE ? statsDemoService : storageStatsService;
const libraryStats = () =>
  env.DEMO_MODE ? statsDemoService : libraryStatsService;
const contentStats = () =>
  env.DEMO_MODE ? statsDemoService : contentStatsService;
const usageStats = () => (env.DEMO_MODE ? statsDemoService : usageStatsService);

async function createAllSnapshots() {
  const [storage, library, content, usage] = await Promise.all([
    storageStats().createStorageSnapshot(),
    libraryStats().createLibrarySnapshot(),
    contentStats().createContentSnapshot(),
    usageStats().createUsageSnapshot(),
  ]);

  return {
    storage,
    library,
    content,
    usage,
  };
}

export async function statsRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.addHook("preHandler", authenticateUser);

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
      const data = await storageStats().getCurrentStorageStats();
      return reply.send({ success: true, data });
    }
  );

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
      const { days, limit } = request.query as HistoryQuery;
      const data = await storageStats().getStorageHistory(days, limit);
      return reply.send({ success: true, data });
    }
  );

  app.post(
    "/storage-snapshots",
    {
      schema: {
        tags: ["stats"],
        summary: "Create storage snapshot",
        description: "Create a storage snapshot resource.",
        response: {
          201: storageSnapshotResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (_request, reply) => {
      const data = await storageStats().createStorageSnapshot();
      return reply
        .status(201)
        .send({ success: true, data, message: "Storage snapshot created" });
    }
  );

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
      const data = await libraryStats().getCurrentLibraryStats();
      return reply.send({ success: true, data });
    }
  );

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
      const { days, limit } = request.query as HistoryQuery;
      const data = await libraryStats().getLibraryHistory(days, limit);
      return reply.send({ success: true, data });
    }
  );

  app.post(
    "/library-snapshots",
    {
      schema: {
        tags: ["stats"],
        summary: "Create library snapshot",
        description: "Create a library snapshot resource.",
        response: {
          201: librarySnapshotResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (_request, reply) => {
      const data = await libraryStats().createLibrarySnapshot();
      return reply
        .status(201)
        .send({ success: true, data, message: "Library snapshot created" });
    }
  );

  app.get(
    "/content",
    {
      schema: {
        tags: ["stats"],
        summary: "Get current content organization statistics",
        description:
          "Returns statistics about content organization including videos without tags, creators, ratings, and storyboards.",
        response: {
          200: contentCurrentResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (_request, reply) => {
      const data = await contentStats().getCurrentContentStats();
      return reply.send({ success: true, data });
    }
  );

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
      const { days, limit } = request.query as HistoryQuery;
      const data = await contentStats().getContentHistory(days, limit);
      return reply.send({ success: true, data });
    }
  );

  app.post(
    "/content-snapshots",
    {
      schema: {
        tags: ["stats"],
        summary: "Create content snapshot",
        description: "Create a content statistics snapshot resource.",
        response: {
          201: contentSnapshotResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (_request, reply) => {
      const data = await contentStats().createContentSnapshot();
      return reply
        .status(201)
        .send({ success: true, data, message: "Content snapshot created" });
    }
  );

  app.get(
    "/usage",
    {
      schema: {
        tags: ["stats"],
        summary: "Get current usage/watch statistics",
        description:
          "Returns watch and usage statistics including total watch time, top watched videos, and activity by hour.",
        response: {
          200: usageCurrentResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (_request, reply) => {
      const data = await usageStats().getCurrentUsageStats();
      return reply.send({ success: true, data });
    }
  );

  app.get(
    "/usage/history",
    {
      schema: {
        tags: ["stats"],
        summary: "Get usage statistics history",
        description: "Returns historical usage and watch snapshots.",
        querystring: historyQuerySchema,
        response: {
          200: usageHistoryResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { days, limit } = request.query as HistoryQuery;
      const data = await usageStats().getUsageHistory(days, limit);
      return reply.send({ success: true, data });
    }
  );

  app.post(
    "/usage-snapshots",
    {
      schema: {
        tags: ["stats"],
        summary: "Create usage snapshot",
        description: "Create a usage statistics snapshot resource.",
        response: {
          201: usageSnapshotResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (_request, reply) => {
      const data = await usageStats().createUsageSnapshot();
      return reply
        .status(201)
        .send({ success: true, data, message: "Usage snapshot created" });
    }
  );

  app.post(
    "/snapshots",
    {
      schema: {
        tags: ["stats"],
        summary: "Create all snapshots",
        description:
          "Create snapshot resources for all statistics types in one request.",
        response: {
          201: allSnapshotsResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (_request, reply) => {
      const data = await createAllSnapshots();
      return reply
        .status(201)
        .send({ success: true, data, message: "All snapshots created" });
    }
  );
}

export async function statsLegacySnapshotRoutes(
  fastify: FastifyInstance
): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.addHook("preHandler", authenticateUser);

  app.post(
    "/storage/snapshot",
    {
      schema: {
        tags: ["stats"],
        deprecated: true,
        summary: "Create storage snapshot (deprecated)",
        description: "Deprecated alias for POST /api/stats/storage-snapshots.",
        response: {
          201: storageSnapshotResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (_request, reply) => {
      markRouteDeprecated(reply, {
        replacement: "/api/stats/storage-snapshots",
      });
      const data = await storageStats().createStorageSnapshot();
      return reply
        .status(201)
        .send({ success: true, data, message: "Storage snapshot created" });
    }
  );

  app.post(
    "/library/snapshot",
    {
      schema: {
        tags: ["stats"],
        deprecated: true,
        summary: "Create library snapshot (deprecated)",
        description: "Deprecated alias for POST /api/stats/library-snapshots.",
        response: {
          201: librarySnapshotResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (_request, reply) => {
      markRouteDeprecated(reply, {
        replacement: "/api/stats/library-snapshots",
      });
      const data = await libraryStats().createLibrarySnapshot();
      return reply
        .status(201)
        .send({ success: true, data, message: "Library snapshot created" });
    }
  );

  app.post(
    "/content/snapshot",
    {
      schema: {
        tags: ["stats"],
        deprecated: true,
        summary: "Create content snapshot (deprecated)",
        description: "Deprecated alias for POST /api/stats/content-snapshots.",
        response: {
          201: contentSnapshotResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (_request, reply) => {
      markRouteDeprecated(reply, {
        replacement: "/api/stats/content-snapshots",
      });
      const data = await contentStats().createContentSnapshot();
      return reply
        .status(201)
        .send({ success: true, data, message: "Content snapshot created" });
    }
  );

  app.post(
    "/usage/snapshot",
    {
      schema: {
        tags: ["stats"],
        deprecated: true,
        summary: "Create usage snapshot (deprecated)",
        description: "Deprecated alias for POST /api/stats/usage-snapshots.",
        response: {
          201: usageSnapshotResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (_request, reply) => {
      markRouteDeprecated(reply, { replacement: "/api/stats/usage-snapshots" });
      const data = await usageStats().createUsageSnapshot();
      return reply
        .status(201)
        .send({ success: true, data, message: "Usage snapshot created" });
    }
  );

  app.post(
    "/snapshot",
    {
      schema: {
        tags: ["stats"],
        deprecated: true,
        summary: "Create all snapshots (deprecated)",
        description: "Deprecated alias for POST /api/stats/snapshots.",
        response: {
          201: allSnapshotsResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (_request, reply) => {
      markRouteDeprecated(reply, { replacement: "/api/stats/snapshots" });
      const data = await createAllSnapshots();
      return reply
        .status(201)
        .send({ success: true, data, message: "All snapshots created" });
    }
  );
}
