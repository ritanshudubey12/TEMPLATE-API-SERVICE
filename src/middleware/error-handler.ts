import type { ErrorRequestHandler, RequestHandler } from "express";
import { AppError } from "../errors";
import { sendError } from "../http";
import type { Logger } from "../observability/logger";

export const notFoundHandler: RequestHandler = (_req, res) => {
  sendError(res, 404, "NOT_FOUND", "Route not found.");
};

export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err, req, res, next) => {
    if (res.headersSent) return next(err);

    if (err instanceof AppError) return sendError(res, err.status, err.code, err.message, err.details);

    const type = (err as { type?: string }).type;
    if (type === "entity.too.large") return sendError(res, 413, "PAYLOAD_TOO_LARGE", "Request body exceeds the configured limit.");
    if (type === "entity.parse.failed" || (err instanceof SyntaxError && "body" in err)) {
      return sendError(res, 400, "VALIDATION_ERROR", "Malformed JSON body.");
    }

    // Never return stack traces, SQL text or driver messages to clients.
    logger.error({ requestId: res.locals.requestId, method: req.method, path: req.path, err: (err as Error)?.message }, "unhandled error");
    return sendError(res, 500, "INTERNAL_ERROR", "An unexpected error occurred.");
  };
}
