import { SeverityNumber, type AnyValue, type LogAttributes } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
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
const MAX_STRING_LENGTH = 4_096;
const MAX_STACK_LENGTH = 16_384;
const MAX_ARRAY_LENGTH = 25;
const MAX_OBJECT_KEYS = 40;
const MAX_DEPTH = 5;
const REDACTED = "[REDACTED]";
const REDACTED_MEDIA_PATH = "[REDACTED_MEDIA_PATH]";
const REDACTED_MEDIA_FILE = "[REDACTED_MEDIA_FILE]";
const TRUNCATED = "[truncated]";

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

const OTEL_SEVERITY: Record<LogLevel, SeverityNumber> = {
  debug: SeverityNumber.DEBUG,
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
  fatal: SeverityNumber.FATAL,
};

const SENSITIVE_KEY_PATTERN =
  /(?:authorization|cookie|password|passwd|secret|token|api[_-]?key|credential|session[_-]?id)/i;
const COMMAND_KEY_PATTERN =
  /(?:command|cmd|argv|args|ffmpeg|stderr|stdout|payload|request[_-]?body|requestBody|response[_-]?body|responseBody)/i;
const MEDIA_LOCATION_KEY_PATTERN =
  /(?:(?:media|video|audio|image|thumbnail|artwork|source|output|input|file).*(?:path|name|url)|(?:path|filename|file_name|filepath))/i;
const NETWORK_IDENTIFIER_KEY_PATTERN =
  /^(?:ip|ip_address|remoteAddress|remote_address|remotePort|remote_port)$/i;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const SECRET_QUERY_PATTERN =
  /([?&](?:token|key|api_key|password|secret|signature)=)[^&#\s]+/gi;
const ABSOLUTE_DATA_PATH_PATTERN =
  /(?:\/(?:home|mnt|media|tmp|var|data)\/[^\s'"<>]+|[A-Za-z]:\\[^\s'"<>]+)/g;
const MEDIA_FILENAME_PATTERN =
  /\b[^\s/'"<>]+\.(?:mp4|mkv|webm|mov|avi|m4v|mp3|flac|wav|m4a|aac|jpg|jpeg|png|webp|gif)\b/gi;
const MEDIA_PATH_IN_STACK_PATTERN =
  /(?:[A-Za-z]:\\|\/)(?:[^\s"'<>|]+[\\/])*[^\s"'<>|]+\.(?:mp4|mkv|webm|mov|avi|m4v|mp3|flac|wav|m4a|aac|jpg|jpeg|png|webp|gif)/gi;

const telemetryEnabled =
  !env.DEMO_MODE && env.NODE_ENV !== "test" && env.POSTHOG_API_KEY.length > 0;

function reportTelemetryTransportError(surface: string, error: unknown): void {
  const name = error instanceof Error ? error.name : "UnknownError";
  process.stderr.write(`[posthog:${surface}] telemetry delivery failed (${name})\n`);
}

function createPostHogClient(flushAt: number, flushInterval: number): PostHog | null {
  if (!telemetryEnabled) return null;

  try {
    const client = new PostHog(env.POSTHOG_API_KEY, {
      host: env.POSTHOG_HOST,
      flushAt,
      flushInterval,
      requestTimeout: 5_000,
      disableGeoip: true,
    });

    client.register({
      service: SERVICE_NAME,
      environment: env.NODE_ENV,
      serviceVersion: env.POSTHOG_SERVICE_VERSION,
    });
    client.on("error", (error) => reportTelemetryTransportError("events", error));
    return client;
  } catch (error) {
    reportTelemetryTransportError("events-init", error);
    return null;
  }
}

const analyticsClient = createPostHogClient(20, 10_000);
const exceptionClient = createPostHogClient(1, 0);

function createLogsEndpoint(host: string): string {
  const endpoint = new URL(host);
  endpoint.search = "";
  endpoint.hash = "";
  endpoint.pathname = endpoint.pathname.replace(/\/+$/, "");

  if (!endpoint.pathname.endsWith("/i/v1/logs")) {
    endpoint.pathname = `${endpoint.pathname}/i/v1/logs`.replace(/\/{2,}/g, "/");
  }

  return endpoint.toString();
}

function createOtelLogger(): {
  provider: LoggerProvider;
  logger: ReturnType<LoggerProvider["getLogger"]>;
} | null {
  if (!telemetryEnabled) return null;

  try {
    const exporter = new OTLPLogExporter({
      url: createLogsEndpoint(env.POSTHOG_HOST),
      headers: { Authorization: `Bearer ${env.POSTHOG_API_KEY}` },
      timeoutMillis: 5_000,
    });
    const provider = new LoggerProvider({
      resource: resourceFromAttributes({
        "service.name": SERVICE_NAME,
        "deployment.environment": env.NODE_ENV,
        "service.version": env.POSTHOG_SERVICE_VERSION,
      }),
      logRecordLimits: {
        attributeCountLimit: 64,
        attributeValueLengthLimit: MAX_STACK_LENGTH,
      },
      processors: [
        new BatchLogRecordProcessor({
          exporter,
          maxQueueSize: 2_048,
          maxExportBatchSize: 256,
          scheduledDelayMillis: 1_000,
          exportTimeoutMillis: 5_000,
        }),
      ],
    });

    return {
      provider,
      logger: provider.getLogger(SERVICE_NAME, env.POSTHOG_SERVICE_VERSION),
    };
  } catch (error) {
    reportTelemetryTransportError("logs-init", error);
    return null;
  }
}

const otel = createOtelLogger();

function truncate(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  return `${value.slice(0, Math.max(0, maximum - TRUNCATED.length - 1))} ${TRUNCATED}`;
}

function redactSecrets(value: string): string {
  return value
    .replace(BEARER_PATTERN, `Bearer ${REDACTED}`)
    .replace(SECRET_QUERY_PATTERN, `$1${REDACTED}`);
}

function sanitizeMessage(value: string): string {
  return truncate(
    redactSecrets(value)
      .replace(ABSOLUTE_DATA_PATH_PATTERN, REDACTED_MEDIA_PATH)
      .replace(MEDIA_FILENAME_PATTERN, REDACTED_MEDIA_FILE),
    MAX_STRING_LENGTH,
  );
}

function sanitizeStack(error: Error, message: string): string | undefined {
  if (!error.stack) return undefined;

  const [, ...frames] = error.stack.split("\n");
  return truncate(
    redactSecrets([`${error.name}: ${message}`, ...frames].join("\n")).replace(
      MEDIA_PATH_IN_STACK_PATTERN,
      REDACTED_MEDIA_PATH,
    ),
    MAX_STACK_LENGTH,
  );
}

function sanitizeError(error: unknown, depth = 0): Error {
  if (!(error instanceof Error)) {
    return new Error(sanitizeMessage(String(error)));
  }

  const message = sanitizeMessage(error.message);
  const cause =
    depth < MAX_DEPTH && "cause" in error && error.cause !== undefined
      ? sanitizeError(error.cause, depth + 1)
      : undefined;
  const sanitized = new Error(message, cause ? { cause } : undefined);
  sanitized.name = truncate(error.name || "Error", 128);
  sanitized.stack = sanitizeStack(error, message);
  return sanitized;
}

function shouldRedactKey(key: string): boolean {
  return (
    SENSITIVE_KEY_PATTERN.test(key) ||
    COMMAND_KEY_PATTERN.test(key) ||
    MEDIA_LOCATION_KEY_PATTERN.test(key) ||
    NETWORK_IDENTIFIER_KEY_PATTERN.test(key)
  );
}

function sanitizeValue(
  value: unknown,
  key: string,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (shouldRedactKey(key)) return REDACTED;
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    if (/^(?:url|uri|href)$/i.test(key)) {
      return sanitizeMessage(sanitizeTelemetryUrl(value));
    }
    return sanitizeMessage(value);
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();

  if (value instanceof Error) {
    const sanitized = sanitizeError(value);
    return {
      type: sanitized.name,
      message: sanitized.message,
      stacktrace: sanitized.stack,
    };
  }

  if (depth >= MAX_DEPTH) return TRUNCATED;

  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ARRAY_LENGTH)
      .map((entry) => sanitizeValue(entry, key, depth + 1, seen));
  }

  if (typeof value === "object") {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    const sanitized = Object.fromEntries(
      Object.entries(value)
        .slice(0, MAX_OBJECT_KEYS)
        .map(([entryKey, entry]) => [
          entryKey,
          sanitizeValue(entry, entryKey, depth + 1, seen),
        ]),
    );
    seen.delete(value);
    return sanitized;
  }

  return truncate(String(value), MAX_STRING_LENGTH);
}

export function sanitizeTelemetryProperties(
  properties: TelemetryProperties,
): Record<string, unknown> {
  const seen = new WeakSet<object>();
  return Object.fromEntries(
    Object.entries(properties)
      .slice(0, MAX_OBJECT_KEYS)
      .map(([key, value]) => [key, sanitizeValue(value, key, 0, seen)]),
  );
}

function buildProperties(
  properties: TelemetryProperties = {},
): Record<string, unknown> {
  return {
    service: SERVICE_NAME,
    environment: env.NODE_ENV,
    serviceVersion: env.POSTHOG_SERVICE_VERSION,
    $process_person_profile: false,
    ...sanitizeTelemetryProperties(properties),
  };
}

export function getTelemetryDistinctId(
  userId?: string | number | null,
): string {
  if (userId === null || userId === undefined || userId === "") {
    return SERVER_DISTINCT_ID;
  }

  return `user:${userId}`;
}

export function sanitizeTelemetryUrl(url: string): string {
  const withoutSecrets = redactSecrets(url.split("#", 1)[0]);
  return withoutSecrets
    .replace(/^(\/api\/cast\/)[a-f0-9]{64}(\/[^?]*)/, "$1:token$2")
    .replace(/\?.*$/, "");
}

export function captureTelemetryEvent(
  event: string,
  properties: TelemetryProperties = {},
  distinctId = SERVER_DISTINCT_ID,
): void {
  if (!analyticsClient) return;

  try {
    analyticsClient.capture({
      distinctId,
      event: truncate(event, 200),
      properties: buildProperties(properties),
    });
  } catch (error) {
    reportTelemetryTransportError("events-capture", error);
  }
}

export function captureTelemetryException(
  error: unknown,
  properties: TelemetryProperties = {},
  distinctId = SERVER_DISTINCT_ID,
): void {
  if (!exceptionClient) return;

  try {
    exceptionClient.captureException(
      sanitizeError(error),
      distinctId,
      buildProperties(properties),
    );
  } catch (captureError) {
    reportTelemetryTransportError("exception-capture", captureError);
  }
}

export async function captureTelemetryExceptionImmediate(
  error: unknown,
  properties: TelemetryProperties = {},
  distinctId = SERVER_DISTINCT_ID,
): Promise<void> {
  if (!exceptionClient) return;

  try {
    await exceptionClient.captureExceptionImmediate(
      sanitizeError(error),
      distinctId,
      buildProperties(properties),
    );
  } catch (captureError) {
    reportTelemetryTransportError("exception-immediate", captureError);
  }
}

export function normalizeTelemetryLog(args: unknown[]): {
  message: string;
  attributes: LogAttributes;
} {
  const [first, second, ...rest] = args;
  const rawProperties: TelemetryProperties = {};
  let loggedError: unknown;

  if (first instanceof Error) {
    loggedError = first;
  } else if (first && typeof first === "object" && !Array.isArray(first)) {
    const object = first as Record<string, unknown>;
    loggedError = object.err ?? object.error;
    Object.assign(rawProperties, object);
    delete rawProperties.err;
    delete rawProperties.error;
  } else if (first !== undefined && typeof first !== "string") {
    rawProperties.arg0 = first;
  }

  const trailing = typeof second === "string" ? rest : [second, ...rest];
  trailing.forEach((value, index) => {
    if (value !== undefined) rawProperties[`arg${index + 1}`] = value;
  });

  const message =
    typeof second === "string"
      ? second
      : typeof first === "string"
        ? first
        : loggedError instanceof Error
          ? loggedError.message
          : "Log emitted";
  const attributes = sanitizeTelemetryProperties(rawProperties) as LogAttributes;

  if (loggedError !== undefined) {
    const error = sanitizeError(loggedError);
    attributes["exception.type"] = error.name;
    attributes["exception.message"] = error.message;
    if (error.stack) attributes["exception.stacktrace"] = error.stack;
  }

  return { message: sanitizeMessage(message), attributes };
}

export function shouldCaptureLog(level: LogLevel): boolean {
  return (
    otel !== null &&
    LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[env.POSTHOG_LOG_LEVEL]
  );
}

export function captureTelemetryLog(level: LogLevel, args: unknown[]): void {
  if (!shouldCaptureLog(level) || !otel) return;

  try {
    const { message, attributes } = normalizeTelemetryLog(args);
    if (message === "incoming request" || message === "request completed") {
      return;
    }
    otel.logger.emit({
      eventName: "application.log",
      severityNumber: OTEL_SEVERITY[level],
      severityText: level.toUpperCase(),
      body: message,
      attributes: {
        ...attributes,
        "log.level": level,
      } as Record<string, AnyValue>,
    });
  } catch (error) {
    reportTelemetryTransportError("logs-capture", error);
  }
}

export function shouldTrackRequestMetrics(request: FastifyRequest): boolean {
  if (!env.POSTHOG_CAPTURE_REQUEST_METRICS) return false;
  if (request.method === "OPTIONS") return false;

  if (
    /^\/api\/multiplayer-remote\/sessions\/\d+\/join-requests\/pending(?:\?|$)/.test(
      request.url,
    )
  ) {
    return false;
  }

  return !["/health", "/docs", "/docs/", "/ws", "/api/events/stream"].some(
    (path) => request.url === path || request.url.startsWith(`${path}/`),
  );
}

let shutdownPromise: Promise<void> | null = null;

export function shutdownTelemetry(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;

  shutdownPromise = Promise.allSettled([
    analyticsClient?.shutdown(5_000),
    exceptionClient?.shutdown(5_000),
    otel?.provider.shutdown(),
  ]).then((results) => {
    results.forEach((result, index) => {
      if (result.status === "rejected") {
        reportTelemetryTransportError(
          ["events-shutdown", "exceptions-shutdown", "logs-shutdown"][index]!,
          result.reason,
        );
      }
    });
  });
  return shutdownPromise;
}
