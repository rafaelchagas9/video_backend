import pino from "pino";
import { env } from "@/config/env";
import { captureTelemetryLog } from "@/utils/telemetry";

function boundedLogText(value: string, maximum: number): string {
  return value.length <= maximum
    ? value
    : `${value.slice(0, maximum - 12)} [truncated]`;
}

export function serializeLoggerError(error: Error) {
  const serialized = pino.stdSerializers.err(error);
  if (!serialized || typeof serialized !== "object") return serialized;
  if (typeof serialized.message === "string") {
    serialized.message = boundedLogText(serialized.message, 4_096);
  }
  if (typeof serialized.stack === "string") {
    serialized.stack = boundedLogText(serialized.stack, 16_384);
  }
  if (typeof serialized.query === "string") {
    serialized.query = boundedLogText(serialized.query, 4_096);
  }
  if (Array.isArray(serialized.params)) {
    serialized.params = `[omitted ${serialized.params.length} query parameters]`;
  }
  // Drizzle appends its database cause after the full parameter dump. Keep it
  // separately so truncating the wrapper never hides the actionable error.
  if (error?.cause instanceof Error) {
    const cause = error.cause as Error & { code?: string };
    serialized.causeDetails = {
      type: cause.name,
      message: boundedLogText(cause.message, 4_096),
      code: cause.code,
    };
  }
  return serialized;
}

const loggerConfig = {
  level: env.NODE_ENV === "development" ? "debug" : "info",
  serializers: {
    // `err` is Pino's conventional key, but the application historically uses
    // both `err` and `error`. Serialize both so local logs keep the full stack.
    err: serializeLoggerError,
    error: serializeLoggerError,
  },
  transport:
    env.NODE_ENV === "development"
      ? {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "HH:MM:ss Z",
            ignore: "pid,hostname",
          },
        }
      : undefined,
} satisfies pino.LoggerOptions;

export const logger = pino(loggerConfig);

for (const level of ["debug", "info", "warn", "error", "fatal"] as const) {
  const original = logger[level].bind(logger) as (...args: unknown[]) => void;

  (logger as Record<typeof level, (...args: unknown[]) => void>)[level] = (
    ...args: unknown[]
  ) => {
    original(...args);
    captureTelemetryLog(level, args);
  };
}
