import cors from "cors";
import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import type { Pool } from "pg";
import type { JWTVerifyGetKey } from "jose";
import { createAuditWriter } from "./audit/audit.repository";
import type { DevIssuer } from "./auth/keys";
import type { Config } from "./config/env";
import { createDevAuthRouter } from "./dev/dev-auth.routes";
import { sendError } from "./http";
import type { Clients, IdentityClient } from "./integrations/types";
import { authenticate } from "./middleware/authenticate";
import { errorHandler, notFoundHandler } from "./middleware/error-handler";
import { requestId } from "./middleware/request-id";
import type { Logger } from "./observability/logger";
import { createTemplateRouterDeps } from "./wiring";
import { createApiRouter } from "./modules/templates/template.routes";

export type AppDeps = {
  config: Config;
  pool: Pool;
  logger: Logger;
  keyResolver: JWTVerifyGetKey;
  identity: IdentityClient;
  clients: Clients;
  devIssuer?: DevIssuer;
};

export function createApp(deps: AppDeps) {
  const { config, pool, logger } = deps;
  const app = express();
  app.disable("x-powered-by");

  const audit = createAuditWriter(pool, logger);
  const services = createTemplateRouterDeps({ ...deps, audit });

  app.use(requestId());
  app.use(helmet());
  const origins = config.CORS_ALLOWED_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean);
  app.use(cors({ origin: origins.length ? origins : false }));
  // Document cap is enforced precisely in the version service; this is the outer envelope limit.
  app.use(express.json({ limit: config.TEMPLATE_MAX_DOCUMENT_BYTES + 65_536 }));
  app.use(
    rateLimit({
      windowMs: config.RATE_LIMIT_WINDOW_MS,
      limit: config.RATE_LIMIT_MAX_REQUESTS,
      standardHeaders: true,
      legacyHeaders: false,
      skip: (req) => req.path === "/health" || req.path === "/ready",
      handler: (_req, res) => sendError(res, 429, "RATE_LIMITED", "Too many requests. Please retry later."),
    }),
  );

  // Structured access log: no headers, no bodies, no tokens.
  app.use((req, res, next) => {
    const started = process.hrtime.bigint();
    res.on("finish", () => {
      const ctx = res.locals.ctx as { userId: bigint; tenantId: bigint } | undefined;
      logger.info({
        requestId: res.locals.requestId, method: req.method, path: req.originalUrl.split("?")[0], status: res.statusCode,
        latencyMs: Number((process.hrtime.bigint() - started) / 1_000_000n),
        userId: ctx?.userId.toString(), tenantId: ctx?.tenantId.toString(),
      }, "request");
    });
    next();
  });

  // Public: liveness never touches dependencies; readiness reports minimal state.
  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });
  app.get("/ready", async (_req, res) => {
    try {
      await pool.query("SELECT 1");
      res.json({ status: "ready" });
    } catch {
      res.status(503).json({ status: "unavailable" });
    }
  });

  if (config.DEV_AUTH_ENABLED && deps.devIssuer) app.use("/dev", createDevAuthRouter(deps.devIssuer));

  app.use("/api/v1", authenticate(config, deps.keyResolver, deps.identity), createApiRouter(services));

  app.use(notFoundHandler);
  app.use(errorHandler(logger));

  return { app, applyService: services.apply };
}

