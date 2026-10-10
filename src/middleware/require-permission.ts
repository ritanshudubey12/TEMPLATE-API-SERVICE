import type { RequestHandler } from "express";
import type { AuditWriter } from "../audit/audit.repository";
import { forbidden } from "../errors";
import { getCtx } from "../http";
import type { Permission } from "../types";

export function requirePermission(permission: Permission, audit: AuditWriter): RequestHandler {
  return async (req, res, next) => {
    const ctx = getCtx(res);
    if (ctx.permissions.includes(permission)) return next();
    await audit.recordDenied(ctx, permission, req.method, req.path);
    throw forbidden("You do not have permission to perform this operation.", { required: permission });
  };
}
