import Fastify from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import rateLimit from "@fastify/rate-limit";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import compress from "@fastify/compress";
import {
  serializerCompiler,
  validatorCompiler,
  jsonSchemaTransform,
} from "fastify-type-provider-zod";
import { env } from "./config/env";
import { AppError } from "./utils/errors";
import { API_PREFIX } from "./config/constants";
import { schedulerService } from "./modules/scheduler/scheduler.service";

type ValidationIssue = {
  instancePath?: string;
  path?: Array<string | number>;
  message?: string;
  keyword?: string;
  params?: {
    limit?: number;
  };
};

type ValidationErrorLike = Error & {
  validation?: ValidationIssue[];
  validationContext?: string;
};

function formatValidationPath(context: string, issue: ValidationIssue): string {
  if (issue.instancePath && issue.instancePath.length > 0) {
    const segments = issue.instancePath
      .split("/")
      .filter(Boolean)
      .map((segment) => decodeURIComponent(segment));

    return segments.reduce<string>((acc, segment) => {
      return /^\d+$/.test(segment) ? `${acc}[${segment}]` : `${acc}.${segment}`;
    }, context);
  }

  if (issue.path && issue.path.length > 0) {
    return issue.path.reduce<string>((acc, segment) => {
      return typeof segment === "number"
        ? `${acc}[${segment}]`
        : `${acc}.${segment}`;
    }, context);
  }

  return context;
}

function formatValidationIssue(
  context: string,
  issue: ValidationIssue,
): string {
  const path = formatValidationPath(context, issue);
  const message = issue.message ?? "invalid value";
  const hasLimit = typeof issue.params?.limit === "number";
  const limitSuffix = hasLimit ? ` (limit: ${issue.params!.limit})` : "";

  return `${path}: ${message}${limitSuffix}`;
}

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

  // Database is initialized via drizzle.ts on import; no separate pool needed

  // Register plugins
  await fastify.register(cookie, {
    secret: env.SESSION_SECRET,
  });

  await fastify.register(compress, {
    threshold: 1024,
  });

  await fastify.register(cors, {
    origin:
      env.NODE_ENV === "development"
        ? true
        : (origin, callback) => {
            if (!origin) {
              callback(null, true);
              return;
            }

            const allowedOrigins = new Set(
              [
                env.BASE_URL,
                "http://localhost:5173",
                ...env.CORS_ORIGINS.split(","),
              ]
                .map((value) => value.trim())
                .filter((value) => value.length > 0),
            );

            if (allowedOrigins.has(origin)) {
              callback(null, true);
              return;
            }

            let originHostname: string | null = null;
            try {
              originHostname = new URL(origin).hostname.toLowerCase();
            } catch {
              callback(null, false);
              return;
            }

            const allowedHostnameSuffixes = new Set<string>();
            for (const allowedOrigin of allowedOrigins) {
              try {
                const hostname = new URL(allowedOrigin).hostname.toLowerCase();
                const parts = hostname.split(".");
                if (parts.length >= 3) {
                  allowedHostnameSuffixes.add(parts.slice(1).join("."));
                }
              } catch {
                continue;
              }
            }

            const matchesAllowedSuffix = Array.from(
              allowedHostnameSuffixes,
            ).some(
              (suffix) =>
                originHostname === suffix ||
                originHostname.endsWith(`.${suffix}`),
            );

            if (!matchesAllowedSuffix) {
              fastify.log.warn(
                { origin, allowedOrigins: Array.from(allowedOrigins) },
                "Blocked CORS origin",
              );
            }

            callback(null, matchesAllowedSuffix);
          },
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
    max: 10000, // Very high limit for private single-user app
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
          url: env.BASE_URL,
          description: "Development server",
        },
      ],
      tags: [
        { name: "auth", description: "Authentication endpoints" },
        { name: "videos", description: "Video management" },
        { name: "directories", description: "Directory management" },
        { name: "creators", description: "Creator management" },
        { name: "studios", description: "Studio and network management" },
        { name: "tags", description: "Tag management" },
        { name: "ratings", description: "Rating management" },
        { name: "thumbnails", description: "Thumbnail management" },
        { name: "playlists", description: "Playlist management" },
        {
          name: "video-collections",
          description: "Canonical series and episodic collection management",
        },
        { name: "favorites", description: "Favorites management" },
        { name: "bookmarks", description: "Bookmark management" },
        { name: "backup", description: "Database backup and export" },
        { name: "conversion", description: "Video conversion and transcoding" },
        { name: "scheduler", description: "Scan scheduling" },
        { name: "storyboards", description: "Slider preview thumbnails" },
        { name: "events", description: "Server-sent event streams" },
        { name: "stats", description: "System and library statistics" },
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

  // Multipart form data support (for file uploads)
  await fastify.register(multipart, {
    limits: {
      fileSize: 50 * 1024 * 1024, // 50MB max file size for profile pictures
      files: 1, // Only one file per request
    },
  });

  // Global error handler (must be registered BEFORE routes)
  fastify.setErrorHandler((error, request, reply) => {
    const validationError = error as ValidationErrorLike;

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
    if (validationError.validation) {
      const validationContext =
        typeof validationError.validationContext === "string"
          ? validationError.validationContext
          : "body";
      const validationIssues: ValidationIssue[] = Array.isArray(
        validationError.validation,
      )
        ? validationError.validation
        : [];
      const formattedIssues = validationIssues.map((issue) =>
        formatValidationIssue(validationContext, issue),
      );
      const detailsSuffix =
        formattedIssues.length > 1
          ? ` (+${formattedIssues.length - 1} more issue${formattedIssues.length > 2 ? "s" : ""})`
          : "";

      fastify.log.warn(
        {
          requestId: request.id,
          method: request.method,
          url: request.url,
          validationContext,
          validationIssueCount: formattedIssues.length,
          validationIssues: formattedIssues,
        },
        "Request validation failed",
      );

      return reply.status(400).send({
        success: false,
        error: {
          message:
            formattedIssues.length > 0
              ? `Validation failed: ${formattedIssues[0]}${detailsSuffix}`
              : "Validation failed",
          statusCode: 400,
          details: validationIssues,
        },
      });
    }

    // Log unexpected errors
    fastify.log.error(error);

    // Don't expose internal errors in production
    const message =
      env.NODE_ENV === "development"
        ? error instanceof Error
          ? error.message
          : String(error)
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
      const { studiosRoutes } =
        await import("./modules/studios/studios.routes");
      const { tagsRoutes } = await import("./modules/tags/tags.routes");
      const { ratingsRoutes } =
        await import("./modules/ratings/ratings.routes");
      const { thumbnailsRoutes } =
        await import("./modules/thumbnails/thumbnails.routes");
      const { playlistsRoutes } =
        await import("./modules/playlists/playlists.routes");
      const { videoCollectionsRoutes } = await import(
        "./modules/video-collections/video-collections.routes"
      );
      const { favoritesRoutes } =
        await import("./modules/favorites/favorites.routes");
      const { bookmarksRoutes } =
        await import("./modules/bookmarks/bookmarks.routes");
      const { backupRoutes } = await import("./modules/backup/backup.routes");
      const { conversionRoutes } =
        await import("./modules/conversion/conversion.routes");
      const { triageRoutes } = await import("./modules/triage/triage.routes");
      const { videoStatsRoutes } =
        await import("./modules/video-stats/video-stats.routes");
      const { settingsRoutes } =
        await import("./modules/settings/settings.routes");
      const { storyboardsRoutes } =
        await import("./modules/storyboards/storyboards.routes");
      const { statsRoutes } = await import("./modules/stats/stats.routes");
      const { eventsRoutes } = await import("./modules/events/events.routes");
      const { taggingRulesRoutes } =
        await import("./modules/tagging-rules/tagging-rules.routes");
      const { faceRecognitionRoutes } =
        await import("./modules/face-recognition/face-recognition.routes");
      const { editsRoutes } = await import("./modules/edits/edits.routes");

      await instance.register(authRoutes, { prefix: "/auth" });
      await instance.register(directoriesRoutes, { prefix: "/directories" });
      await instance.register(videosRoutes, { prefix: "/videos" });
      await instance.register(creatorsRoutes, { prefix: "/creators" });
      await instance.register(studiosRoutes, { prefix: "/studios" });
      await instance.register(tagsRoutes, { prefix: "/tags" });
      await instance.register(ratingsRoutes, { prefix: "/ratings" });
      await instance.register(thumbnailsRoutes, { prefix: "/" }); // Register at root so it can handle /videos/... and /thumbnails/... prefixes itself or via internally defined paths
      await instance.register(playlistsRoutes, { prefix: "/playlists" });
      await instance.register(videoCollectionsRoutes, {
        prefix: "/video-collections",
      });
      await instance.register(favoritesRoutes, { prefix: "/favorites" });
      await instance.register(bookmarksRoutes, { prefix: "/bookmarks" });
      await instance.register(backupRoutes, { prefix: "/backup" });
      await instance.register(conversionRoutes, { prefix: "/" }); // Conversion routes handle /videos/:id/convert and /conversions/:id paths
      await instance.register(triageRoutes, { prefix: "/users" }); // Triage progress routes under /users
      await instance.register(videoStatsRoutes, { prefix: "/videos" });
      await instance.register(settingsRoutes, { prefix: "/settings" });
      await instance.register(storyboardsRoutes, { prefix: "/" }); // Storyboards routes handle /videos/:id/storyboard.* paths
      await instance.register(statsRoutes, { prefix: "/stats" });
      await instance.register(eventsRoutes, { prefix: "/events" });
      await instance.register(taggingRulesRoutes, { prefix: "/tagging-rules" });
      await instance.register(faceRecognitionRoutes, { prefix: "/" }); // Face recognition routes handle /creators/:id/face-embeddings, /videos/:id/faces, /faces/* paths
      await instance.register(editsRoutes, { prefix: "/" }); // Edits routes handle /videos/:id/edits, /edits/jobs/:id, etc.
    },
    { prefix: API_PREFIX },
  );

  // Start scheduler for automatic directory scanning
  if (env.NODE_ENV !== "test") {
    schedulerService.start().catch((err) => {
      fastify.log.error(err, "Failed to start scheduler");
    });

    const { conversionService } =
      await import("./modules/conversion/conversion.service");
    const { editsQueue } = await import("./modules/edits/edits.queue");
    // Ensure processor is initialized to register callback
    await import("./modules/edits/edits.processor");

    await conversionService.startQueue();
    await editsQueue.start();
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
