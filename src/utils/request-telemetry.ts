import type {
  FastifyBaseLogger,
  FastifyInstance,
  RawServerDefault,
} from "fastify";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as telemetry from "./telemetry";

export function registerRequestTelemetryHooks<Logger extends FastifyBaseLogger>(
  fastify: FastifyInstance<
    RawServerDefault,
    IncomingMessage,
    ServerResponse,
    Logger
  >,
  transport: Pick<
    typeof telemetry,
    "captureTelemetryEvent" | "captureTelemetryLog"
  > = telemetry
): void {
  const {
    getTelemetryDistinctId,
    getRequestTelemetryLogLevel,
    sanitizeTelemetryUrl,
    shouldTrackRequestMetrics,
  } = telemetry;
  fastify.addHook("onRequest", async (request) => {
    request.telemetryStartTime = process.hrtime.bigint();
  });

  fastify.addHook("onResponse", async (request, reply) => {
    if (!request.telemetryStartTime) {
      return;
    }

    const durationMs =
      Number(process.hrtime.bigint() - request.telemetryStartTime) / 1_000_000;

    if (shouldTrackRequestMetrics(request, reply.statusCode)) {
      transport.captureTelemetryEvent(
        "api request completed",
        {
          requestId: request.id,
          method: request.method,
          route: request.routeOptions.url,
          url: sanitizeTelemetryUrl(request.url),
          statusCode: reply.statusCode,
          durationMs,
          authenticated: Boolean(request.user),
        },
        getTelemetryDistinctId(request.user?.id)
      );
    }

    const logLevel = getRequestTelemetryLogLevel(
      request,
      reply.statusCode,
      durationMs
    );
    if (logLevel) {
      transport.captureTelemetryLog(logLevel, [
        {
          requestId: request.id,
          method: request.method,
          route: request.routeOptions.url,
          statusCode: reply.statusCode,
          durationMs,
          authenticated: Boolean(request.user),
        },
        "HTTP request completed",
      ]);
    }
  });
}
