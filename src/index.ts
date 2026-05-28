import { buildServer } from "./server";
import { env } from "./config/env";
import { logger } from "./utils/logger";
import {
  captureTelemetryException,
  shutdownTelemetry,
} from "./utils/telemetry";

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
