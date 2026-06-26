import { buildServer } from "./server";
import { env } from "./config/env";
import { logger } from "./utils/logger";
import { eventsService } from "./modules/events/events.service";
import { multiplayerRemoteWebSocketService } from "./modules/multiplayer-remote/multiplayer-remote.websocket";
import {
  captureTelemetryException,
  shutdownTelemetry,
} from "./utils/telemetry";

const SHUTDOWN_TIMEOUT_MS = 10_000;
type AppServer = Awaited<ReturnType<typeof buildServer>>;

function createShutdownHandler(server: AppServer): (signal: NodeJS.Signals) => void {
  let isShuttingDown = false;

  return (signal) => {
    if (isShuttingDown) {
      logger.warn({ signal }, "Shutdown already in progress, forcing exit");
      process.exit(1);
    }

    isShuttingDown = true;
    logger.info({ signal }, "Shutdown signal received");

    eventsService.closeAll("server shutdown");
    multiplayerRemoteWebSocketService.closeAll("server shutdown");

    const timeout = setTimeout(() => {
      logger.error(
        { signal, timeoutMs: SHUTDOWN_TIMEOUT_MS },
        "Graceful shutdown timed out",
      );
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);

    void server
      .close()
      .then(() => {
        logger.info({ signal }, "Server shutdown complete");
        process.exit(0);
      })
      .catch((error) => {
        captureTelemetryException(error, { source: "shutdown", signal });
        logger.error({ error, signal }, "Server shutdown failed");
        process.exit(1);
      })
      .finally(() => {
        clearTimeout(timeout);
      });
  };
}

function registerProcessTelemetryHandlers(): void {
  process.on("unhandledRejection", (error) => {
    captureTelemetryException(error, { source: "process.unhandledRejection" });
    logger.error({ error }, "Unhandled promise rejection");
  });

  process.on("uncaughtException", (error) => {
    captureTelemetryException(error, { source: "process.uncaughtException" });
    logger.fatal({ error }, "Uncaught exception");

    void shutdownTelemetry().finally(() => {
      process.exit(1);
    });
  });
}

async function main() {
  try {
    registerProcessTelemetryHandlers();

    const server = await buildServer();
    const shutdown = createShutdownHandler(server);

    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);

    await server.listen({
      port: env.PORT,
      host: env.HOST,
    });

    logger.info(`Server listening on http://${env.HOST}:${env.PORT}`);
    logger.info(
      `API documentation available at http://${env.HOST}:${env.PORT}/docs`,
    );
    logger.info(
      `Health check available at http://${env.HOST}:${env.PORT}/health`,
    );
    logger.info(
      `SSE stream available at http://${env.HOST}:${env.PORT}/api/events/stream`,
    );
    logger.info(`URL: ${env.BASE_URL}`);
  } catch (error) {
    captureTelemetryException(error, { source: "startup" });
    logger.error(error);
    await shutdownTelemetry();
    process.exit(1);
  }
}

main();
