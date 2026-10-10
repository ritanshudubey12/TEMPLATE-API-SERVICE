import "dotenv/config";
import { createApp } from "./app";
import { createDevIssuer, createKeyResolver } from "./auth/keys";
import { loadConfig } from "./config/env";
import { createPool } from "./db/pool";
import { startOutboxPublisher } from "./events/outbox.publisher";
import { createHttpClients, createHttpIdentityClient } from "./integrations/http-clients";
import { createMockClients, createMockIdentityClient } from "./integrations/mock-clients";
import { createLogger } from "./observability/logger";

async function main() {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL);
  const pool = createPool(config, logger);

  const devIssuer = config.DEV_AUTH_ENABLED ? await createDevIssuer(config) : undefined;
  const keyResolver = createKeyResolver(config, devIssuer);
  const mock = config.INTEGRATIONS_MODE === "mock";
  const identity = mock ? createMockIdentityClient() : createHttpIdentityClient(config);
  const clients = mock ? createMockClients() : createHttpClients(config);
  if (devIssuer) logger.warn("DEV_AUTH_ENABLED=true: /dev/token is exposed. Never enable this in production.");
  if (mock) logger.warn("INTEGRATIONS_MODE=mock: Identity/Website/Page/Theme/Media are in-process stand-ins.");

  const { app, applyService } = createApp({ config, pool, logger, keyResolver, identity, clients, devIssuer });
  const outbox = startOutboxPublisher({
    pool, logger, intervalMs: config.OUTBOX_POLL_INTERVAL_MS, webhookUrl: config.OUTBOX_WEBHOOK_URL,
  });

  const server = app.listen(config.PORT, () => logger.info({ port: config.PORT }, "Template API listening"));
  applyService
    .recoverIncompleteJobs(config.INTEGRATIONS_SERVICE_TOKEN)
    .then((n) => n > 0 && logger.info({ recovered: n }, "re-queued incomplete apply jobs"))
    .catch((err) => logger.error({ err: (err as Error).message }, "job recovery failed"));

  const shutdown = (signal: string) => {
    logger.info({ signal }, "shutting down");
    outbox.stop();
    server.close(() => void pool.end().then(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
