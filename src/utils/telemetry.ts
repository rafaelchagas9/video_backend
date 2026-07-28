import type { FastifyRequest } from "fastify";
import { PostHog } from "posthog-node";
import { env } from "@/config/env";

declare module "fastify" {
  interface FastifyRequest {
    telemetryStartTime?: bigint;
  }
}

type TelemetryProperties = Record<string, unknown>;
type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";

const SERVICE_NAME = "video-streaming-backend";
const SERVER_DISTINCT_ID = `server:${SERVICE_NAME}`;
const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

const posthogClient =
  !env.DEMO_MODE && env.POSTHOG_API_KEY.length > 0
    ? new PostHog(env.POSTHOG_API_KEY, {
        host: env.POSTHOG_HOST,
        flushAt: 1,
        flushInterval: 0,
        requestTimeout: 5000,
        disableGeoip: true,
      })
    : null;

posthogClient?.register({
  service: SERVICE_NAME,
  environment: env.NODE_ENV,
});

posthogClient?.on("error", (error) => {
  process.stderr.write(
    `[posthog] Failed to send telemetry: ${formatUnknownError(error)}\n`,
  );
});

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? `${error.name}: ${error.message}`;
  }

  return String(error);
}

function serializeValue(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (Array.isArray(value)) {
    return value.map((entry) => serializeValue(entry));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, serializeValue(entry)]),
    );
  }

  return value;
}

function serializeProperties(
  properties: TelemetryProperties,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(properties).map(([key, value]) => [key, serializeValue(value)]),
  );
}

function buildProperties(properties: TelemetryProperties = {}): TelemetryProperties {
  return {
    service: SERVICE_NAME,
    environment: env.NODE_ENV,
    $process_person_profile: false,
    ...serializeProperties(properties),
  };
}

export function isTelemetryEnabled(): boolean {
  return posthogClient !== null;
}

export function getTelemetryDistinctId(userId?: string | number | null): string {
  if (userId === null || userId === undefined || userId === "") {
    return SERVER_DISTINCT_ID;
  }

  return `user:${userId}`;
}

export function captureTelemetryEvent(
  event: string,
  properties: TelemetryProperties = {},
  distinctId = SERVER_DISTINCT_ID,
): void {
  if (!posthogClient) {
    return;
  }

  posthogClient.capture({
    distinctId,
    event,
    properties: buildProperties(properties),
  });
}

export function captureTelemetryException(
  error: unknown,
  properties: TelemetryProperties = {},
  distinctId = SERVER_DISTINCT_ID,
): void {
  if (!posthogClient) {
    return;
  }

  posthogClient.captureException(error, distinctId, buildProperties(properties));
}

function normalizeLogArgs(args: unknown[]): {
  message: string;
  properties: TelemetryProperties;
} {
  const [first, second, ...rest] = args;
  const properties: TelemetryProperties = {};

  if (first instanceof Error) {
    properties.error = serializeValue(first);
  } else if (first && typeof first === "object" && !Array.isArray(first)) {
    Object.assign(properties, serializeValue(first));
  } else if (first !== undefined) {
    properties.arg0 = serializeValue(first);
  }

  for (const [index, value] of rest.entries()) {
    properties[`arg${index + 2}`] = serializeValue(value);
  }

  if (typeof second === "string") {
    return { message: second, properties };
  }

  if (typeof first === "string") {
    return { message: first, properties };
  }

  if (first instanceof Error) {
    return { message: first.message, properties };
  }

  return { message: "Log emitted", properties };
}

export function shouldCaptureLog(level: LogLevel): boolean {
  return (
    isTelemetryEnabled() &&
    LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[env.POSTHOG_LOG_LEVEL]
  );
}

export function captureTelemetryLog(level: LogLevel, args: unknown[]): void {
  if (!shouldCaptureLog(level)) {
    return;
  }

  const { message, properties } = normalizeLogArgs(args);

  captureTelemetryEvent(
    "server log emitted",
    {
      level,
      message,
      ...properties,
    },
    SERVER_DISTINCT_ID,
  );
}

export function shouldTrackRequestMetrics(request: FastifyRequest): boolean {
  if (!env.POSTHOG_CAPTURE_REQUEST_METRICS) {
    return false;
  }

  if (request.method === "OPTIONS") {
    return false;
  }

  return ![
    "/health",
    "/docs",
    "/docs/",
    "/ws",
    "/api/events/stream",
  ].some((path) => request.url === path || request.url.startsWith(`${path}/`));
}

export async function shutdownTelemetry(): Promise<void> {
  if (!posthogClient) {
    return;
  }

  await posthogClient._shutdown(5000);
}
