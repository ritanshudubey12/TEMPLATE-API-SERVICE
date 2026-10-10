export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (message = "Resource not found.") => new AppError(404, "NOT_FOUND", message);
export const forbidden = (message = "You do not have access to this operation.", details?: unknown) =>
  new AppError(403, "FORBIDDEN", message, details);
export const conflict = (message: string, code = "CONFLICT", details?: unknown) =>
  new AppError(409, code, message, details);
export const validationError = (message: string, details?: unknown) =>
  new AppError(400, "VALIDATION_ERROR", message, details);

export function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}
