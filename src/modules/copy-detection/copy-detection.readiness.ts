export const COPY_ENGINE_NOT_READY_CODE = "COPY_ENGINE_NOT_READY" as const;
export const COPY_ENGINE_NOT_READY_REASON =
  "Perceptual duplicate analysis is disabled by server configuration; face and timeline jobs are available.";

export class CopyEngineNotReadyError extends Error {
  readonly code = COPY_ENGINE_NOT_READY_CODE;
  readonly statusCode = 503;

  constructor() {
    super(COPY_ENGINE_NOT_READY_REASON);
    this.name = "CopyEngineNotReadyError";
  }
}

export function assertCopyEngineReady(enabled: boolean): void {
  if (!enabled) throw new CopyEngineNotReadyError();
}

export function isCopyEngineNotReadyError(
  error: unknown
): error is CopyEngineNotReadyError {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === COPY_ENGINE_NOT_READY_CODE
  );
}
