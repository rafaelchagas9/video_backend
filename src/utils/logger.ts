import pino from "pino";
import { env } from "@/config/env";
import { captureTelemetryLog } from "@/utils/telemetry";

const loggerConfig = {
  level: env.NODE_ENV === "development" ? "debug" : "info",
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
