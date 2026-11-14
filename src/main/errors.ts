import type { ErrorCode, IpcError } from "@shared/ipc-contract";
import { ZodError } from "zod";

/**
 * One error taxonomy for the whole main process.
 *
 * Handlers never throw across the IPC boundary. They return `{ ok: false, error }`
 * and the code is drawn from the closed set in the contract, so the UI can render
 * every failure without guessing.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly retryAfterMs?: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    options?: { retryAfterMs?: number; details?: Record<string, unknown>; cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AppError";
    this.code = code;
    if (options?.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
    if (options?.details !== undefined) this.details = options.details;
  }
}

export function toIpcError(err: unknown): IpcError {
  if (err instanceof AppError) {
    return {
      code: err.code,
      message: err.message,
      ...(err.retryAfterMs === undefined ? {} : { retryAfterMs: err.retryAfterMs }),
      ...(err.details === undefined ? {} : { details: err.details }),
    };
  }

  if (err instanceof ZodError) {
    return {
      code: "BAD_REQUEST",
      message: "Request failed validation",
      details: { issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) },
    };
  }

  const message = err instanceof Error ? err.message : String(err);
  return { code: "INTERNAL", message };
}
