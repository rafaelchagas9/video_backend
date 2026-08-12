export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public isOperational = true,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = new.target.name;
    Object.setPrototypeOf(this, AppError.prototype);
    Error.captureStackTrace(this, this.constructor);
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Resource not found") {
    super(404, message);
    Object.setPrototypeOf(this, NotFoundError.prototype);
  }
}

export class ValidationError extends AppError {
  constructor(message = "Validation failed") {
    super(400, message);
    Object.setPrototypeOf(this, ValidationError.prototype);
  }
}

export class BadRequestError extends AppError {
  constructor(message = "Bad request") {
    super(400, message);
    Object.setPrototypeOf(this, BadRequestError.prototype);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Unauthorized") {
    super(401, message);
    Object.setPrototypeOf(this, UnauthorizedError.prototype);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Forbidden") {
    super(403, message);
    Object.setPrototypeOf(this, ForbiddenError.prototype);
  }
}

export class ConflictError extends AppError {
  constructor(message = "Resource already exists") {
    super(409, message);
    Object.setPrototypeOf(this, ConflictError.prototype);
  }
}

export class InternalServerError extends AppError {
  constructor(message = "Internal server error", options?: ErrorOptions) {
    super(500, message, false, options);
    Object.setPrototypeOf(this, InternalServerError.prototype);
  }
}

type HttpErrorLike = {
  statusCode?: unknown;
};

/**
 * Preserve status codes produced by Fastify and its plugins. Invalid or missing
 * codes remain unexpected server failures.
 */
export function getHttpErrorStatusCode(error: unknown): number {
  const statusCode = (error as HttpErrorLike | null)?.statusCode;

  return typeof statusCode === "number" &&
    Number.isInteger(statusCode) &&
    statusCode >= 400 &&
    statusCode <= 599
    ? statusCode
    : 500;
}

/** Expected client errors are useful logs, but should not become PostHog issues. */
export function shouldCaptureHttpError(error: unknown): boolean {
  return getHttpErrorStatusCode(error) >= 500;
}

/**
 * Extracts a PostgreSQL error code (e.g. "23505") from an error thrown by the
 * database layer. Drizzle wraps the underlying PostgresError in a
 * DrizzleQueryError, so the SQLSTATE `code` lives on the error's `cause` chain
 * rather than on the top-level error. This walks that chain to find it.
 */
export function getPostgresErrorCode(error: unknown): string | undefined {
  let current: unknown = error;

  // Bound the walk so a self-referential cause can never loop forever.
  for (let depth = 0; depth < 10 && current; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") {
      return code;
    }
    current = (current as { cause?: unknown }).cause;
  }

  return undefined;
}

/** Whether the error represents a Postgres unique-constraint violation (23505). */
export function isUniqueViolation(error: unknown): boolean {
  return getPostgresErrorCode(error) === "23505";
}

/** Whether the error represents a Postgres foreign-key violation (23503). */
export function isForeignKeyViolation(error: unknown): boolean {
  return getPostgresErrorCode(error) === "23503";
}
