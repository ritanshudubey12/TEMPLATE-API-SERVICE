import type { Response } from "express";
import { AppError } from "./errors";
import type { RequestContext } from "./types";

export function send(res: Response, status: number, data: unknown, meta: Record<string, unknown> = {}) {
  res.status(status).json({ success: true, data, meta: { requestId: res.locals.requestId, ...meta } });
}

export function sendError(res: Response, status: number, code: string, message: string, details?: unknown) {
  res.status(status).json({
    success: false,
    error: { code, message, details: details ?? {} },
    meta: { requestId: res.locals.requestId },
  });
}

export function getCtx(res: Response): RequestContext {
  const ctx = res.locals.ctx as RequestContext | undefined;
  if (!ctx) throw new AppError(401, "UNAUTHENTICATED", "A valid Bearer token is required.");
  return ctx;
}
