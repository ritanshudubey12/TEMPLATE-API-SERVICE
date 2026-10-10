import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";

export function requestId(): RequestHandler {
  return (req, res, next) => {
    const incoming = req.header("x-request-id");
    const id = incoming && /^[A-Za-z0-9._-]{1,64}$/.test(incoming) ? incoming : `req_${randomUUID()}`;
    res.locals.requestId = id;
    res.setHeader("X-Request-Id", id);
    next();
  };
}
