import { randomUUID } from "node:crypto";

export type WorkflowErrorCode = "INVALID_INPUT" | "NOT_FOUND" | "CONFLICT" | "RECOVERY_REQUIRED" | "RESOURCE_UNAVAILABLE";

/** Typed domain errors remain compatible with clients reading error:string. */
export class WorkflowError extends Error {
  constructor(
    public readonly code: WorkflowErrorCode,
    message: string,
    public readonly status: number,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "WorkflowError";
  }
}

export function rethrowWorkflowError(error: unknown): void {
  if (error instanceof WorkflowError) throw error;
}

/** Catch only known domain errors; retain Next's handling of unexpected bugs. */
export function withWorkflowErrors<Args extends unknown[]>(handler: (...args: Args) => Promise<Response>) {
  return async (...args: Args): Promise<Response> => {
    try {
      return await handler(...args);
    } catch (error) {
      if (!(error instanceof WorkflowError)) throw error;
      return Response.json({
        error: error.message,
        detail: { code: error.code, message: error.message, retryable: error.retryable, requestId: randomUUID() },
      }, { status: error.status });
    }
  };
}
