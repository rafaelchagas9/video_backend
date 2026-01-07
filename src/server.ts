import Fastify from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import rateLimit from "@fastify/rate-limit";
import helmet from "@fastify/helmet";
import {
  serializerCompiler,
  validatorCompiler,
  jsonSchemaTransform,
} from "fastify-type-provider-zod";
import { env } from "./config/env";
import { AppError } from "./utils/errors";
import { API_PREFIX } from "./config/constants";
import { getDatabase } from "./config/database";
import { schedulerService } from "./modules/scheduler/scheduler.service";

export async function buildServer() {
  const fastify = Fastify({
    logger:
      env.NODE_ENV === "development"
        ? {
            level: "debug",
            transport: {
              target: "pino-pretty",
              options: {
                colorize: true,
                translateTime: "HH:MM:ss Z",
                ignore: "pid,hostname",
              },
            },
          }
        : {
            level: "info",
          },
    disableRequestLogging: false,
    requestIdHeader: "x-request-id",
  });

  // Set up Zod type provider for schema validation and OpenAPI generation
  fastify.setValidatorCompiler(validatorCompiler);
  fastify.setSerializerCompiler(serializerCompiler);

  // Initialize database
  getDatabase();

  // Register plugins
  await fastify.register(cookie, {
    secret: env.SESSION_SECRET,
  });

  await fastify.register(cors, {
    origin: env.NODE_ENV === "development" ? true : ["http://localhost:3000", "http://localhost:5173"],
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Range"],
    exposedHeaders: ["Content-Range", "Accept-Ranges", "Content-Length"],
  });

  // Security hardening
  await fastify.register(helmet, {
    contentSecurityPolicy: env.NODE_ENV === "production",
    crossOriginResourcePolicy: { policy: "cross-origin" },
    crossOriginEmbedderPolicy: false,
  });

  await fastify.register(rateLimit, {
    max: 100, // 100 requests per minute
    timeWindow: "1 minute",
  });

  // Swagger documentation
  await fastify.register(swagger, {
    transform: jsonSchemaTransform,
    openapi: {
      info: {
        title: "Video Streaming Backend API",
        description:
          "API for managing and streaming video files. **Authentication**: Use the `POST /auth/login` endpoint to authenticate. The browser will automatically manage the secure session cookie.",
        version: "0.1.0",
      },
      servers: [
        {
          url: `http://${env.HOST}:${env.PORT}`,
          description: "Development server",
        },
      ],
      tags: [
        { name: "auth", description: "Authentication endpoints" },
        { name: "videos", description: "Video management" },
        { name: "directories", description: "Directory management" },
        { name: "creators", description: "Creator management" },
        { name: "tags", description: "Tag management" },
        { name: "ratings", description: "Rating management" },
        { name: "thumbnails", description: "Thumbnail management" },
        { name: "playlists", description: "Playlist management" },
        { name: "favorites", description: "Favorites management" },
        { name: "bookmarks", description: "Bookmark management" },
        { name: "backup", description: "Database backup and export" },
        { name: "scheduler", description: "Scan scheduling" },
        { name: "system", description: "System health and status" },
      ],
    },
  });

  await fastify.register(swaggerUi, {
    routePrefix: "/docs",
    uiConfig: {
      docExpansion: "list",
      deepLinking: true,
    },
  });

  // Global error handler (must be registered BEFORE routes)
  fastify.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({
        success: false,
        error: {
          message: error.message,
          statusCode: error.statusCode,
        },
      });
    }

    // Zod validation errors
    if ((error as any).validation) {
      return reply.status(400).send({
        success: false,
        error: {
          message: "Validation failed",
          statusCode: 400,
          details: (error as any).validation,
        },
      });
    }

    // Log unexpected errors
    fastify.log.error(error);

    // Don't expose internal errors in production
    const message =
      env.NODE_ENV === "development"
        ? (error as any).message || String(error)
        : "Internal server error";

    return reply.status(500).send({
      success: false,
      error: {
        message,
        statusCode: 500,
      },
    });
  });

  // Health check endpoint
  fastify.get("/health", { schema: { tags: ["system"] } }, async () => {
    return {
      status: "ok",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    };
  });

  // Register API routes
  await fastify.register(
    async (instance) => {
      const { authRoutes } = await import("./modules/auth/auth.routes");
      const { directoriesRoutes } =
        await import("./modules/directories/directories.routes");
      const { videosRoutes } = await import("./modules/videos/videos.routes");
      const { creatorsRoutes } =
        await import("./modules/creators/creators.routes");
      const { tagsRoutes } = await import("./modules/tags/tags.routes");
      const { ratingsRoutes } =
        await import("./modules/ratings/ratings.routes");
      const { thumbnailsRoutes } =
        await import("./modules/thumbnails/thumbnails.routes");
      const { playlistsRoutes } =
        await import("./modules/playlists/playlists.routes");
      const { favoritesRoutes } =
        await import("./modules/favorites/favorites.routes");
      const { bookmarksRoutes } =
        await import("./modules/bookmarks/bookmarks.routes");
      const { backupRoutes } = await import("./modules/backup/backup.routes");

      await instance.register(authRoutes, { prefix: "/auth" });
      await instance.register(directoriesRoutes, { prefix: "/directories" });
      await instance.register(videosRoutes, { prefix: "/videos" });
      await instance.register(creatorsRoutes, { prefix: "/creators" });
      await instance.register(tagsRoutes, { prefix: "/tags" });
      await instance.register(ratingsRoutes, { prefix: "/ratings" });
      await instance.register(thumbnailsRoutes, { prefix: "/" }); // Register at root so it can handle /videos/... and /thumbnails/... prefixes itself or via internally defined paths
      await instance.register(playlistsRoutes, { prefix: "/playlists" });
      await instance.register(favoritesRoutes, { prefix: "/favorites" });
      await instance.register(bookmarksRoutes, { prefix: "/bookmarks" });
      await instance.register(backupRoutes, { prefix: "/backup" });
    },
    { prefix: API_PREFIX },
  );

  // Start scheduler for automatic directory scanning
  if (env.NODE_ENV !== "test") {
    schedulerService.start().catch((err) => {
      fastify.log.error(err, "Failed to start scheduler");
    });
  }

  // 404 handler
  fastify.setNotFoundHandler((request, reply) => {
    return reply.status(404).send({
      success: false,
      error: {
        message: "Route not found",
        statusCode: 404,
        path: request.url,
      },
    });
  });

  return fastify;
}
