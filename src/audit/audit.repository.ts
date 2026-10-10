import type { Db } from "../db/pool";
import type { Logger } from "../observability/logger";
import type { RequestContext } from "../types";

export type AuditEntry = {
  tenantId: string;
  organizationId: string;
  actorUserId: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  requestId: string | null;
  metadata: Record<string, unknown>;
};

export function auditFromCtx(
  ctx: RequestContext,
  action: string,
  resourceType: string,
  resourceId: string | null,
  metadata: Record<string, unknown> = {},
): AuditEntry {
  return {
    tenantId: ctx.tenantId.toString(),
    organizationId: ctx.organizationId.toString(),
    actorUserId: ctx.userId.toString(),
    action,
    resourceType,
    resourceId,
    requestId: ctx.requestId,
    metadata,
  };
}

export async function insertAudit(db: Db, e: AuditEntry): Promise<void> {
  await db.query(
    `INSERT INTO template_audit_logs
       (tenant_id, organization_id, actor_user_id, action, resource_type, resource_id, request_id, metadata)
     VALUES ($1::bigint, $2::bigint, $3::bigint, $4, $5, $6, $7, $8::jsonb)`,
    [e.tenantId, e.organizationId, e.actorUserId, e.action, e.resourceType, e.resourceId, e.requestId, JSON.stringify(e.metadata)],
  );
}

/** Best-effort audit writer for security-denied actions (outside any business transaction). */
export function createAuditWriter(pool: Db, logger: Logger) {
  return {
    async recordDenied(ctx: RequestContext, permission: string, method: string, path: string) {
      try {
        await insertAudit(pool, auditFromCtx(ctx, "security.denied", "route", null, { permission, method, path }));
      } catch (err) {
        logger.warn({ err: (err as Error).message }, "failed to write denied-action audit entry");
      }
    },
  };
}

export type AuditWriter = ReturnType<typeof createAuditWriter>;
