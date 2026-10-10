import { Pool, type PoolClient } from "pg";
import type { Config } from "../config/env";
import type { Logger } from "../observability/logger";

export type Db = Pool | PoolClient;

export function createPool(config: Config, logger: Logger): Pool {
  const pool = new Pool({
    connectionString: config.DATABASE_URL,
    max: config.DB_POOL_MAX,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 30_000,
  });
  pool.on("error", (err) => logger.error({ err: err.message }, "idle database client error"));
  return pool;
}

export async function withTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
