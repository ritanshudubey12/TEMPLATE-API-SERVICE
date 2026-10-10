import type { PoolClient } from "pg";
import { conflict } from "../../errors";
import type { RequestContext } from "../../types";

/**
 * Must run inside the same transaction as the guarded work.
 * Returns null when this request owns the key (go ahead), or the stored response for a replay.
 * Same key + different request hash => 409 IDEMPOTENCY_CONFLICT.
 */
export async function beginIdempotent(
  c: PoolClient,
  ctx: RequestContext,
  operation: string,
  key: string,
  hash: string,
): Promise<{ status: number; body: unknown } | null> {
  const scope = [ctx.tenantId.toString(), ctx.organizationId.toString(), operation, key];
  const inserted = await c.query(
    `INSERT INTO idempotency_keys (tenant_id, organization_id, operation, idempotency_key, request_hash)
     VALUES ($1::bigint, $2::bigint, $3, $4, $5)
     ON CONFLICT (tenant_id, organization_id, operation, idempotency_key) DO NOTHING
     RETURNING id`,
    [...scope, hash],
  );
  if (inserted.rowCount === 1) return null;

  const { rows } = await c.query(
    `SELECT request_hash, response_status, response_json FROM idempotency_keys
      WHERE tenant_id = $1::bigint AND organization_id = $2::bigint AND operation = $3 AND idempotency_key = $4`,
    scope,
  );
  const row = rows[0];
  if (row.request_hash !== hash) {
    throw conflict("This Idempotency-Key was already used with a different request.", "IDEMPOTENCY_CONFLICT");
  }
  return { status: row.response_status, body: row.response_json };
}

export async function completeIdempotent(
  c: PoolClient,
  ctx: RequestContext,
  operation: string,
  key: string,
  status: number,
  body: unknown,
): Promise<void> {
  await c.query(
    `UPDATE idempotency_keys SET response_status = $5, response_json = $6::jsonb
      WHERE tenant_id = $1::bigint AND organization_id = $2::bigint AND operation = $3 AND idempotency_key = $4`,
    [ctx.tenantId.toString(), ctx.organizationId.toString(), operation, key, status, JSON.stringify(body)],
  );
}
