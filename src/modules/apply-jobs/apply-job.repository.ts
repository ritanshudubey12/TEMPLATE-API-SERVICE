import type { Db } from "../../db/pool";

export type JobRow = {
  id: string;
  templateId: string;
  versionId: string;
  websiteId: string;
  status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED";
  options: { mode: string; includeTheme: boolean; mediaPolicy: string; expectedWebsiteRevision?: number };
  result: unknown;
  errorCode: string | null;
  attempts: number;
  createdBy: string;
  tenantId: string;
  organizationId: string;
  requestHash: string;
  createdAt: Date;
  updatedAt: Date;
};

const COLS = `
  j.id::text AS id, j.template_id::text AS "templateId", j.version_id::text AS "versionId",
  j.website_id::text AS "websiteId", j.status, j.request_json AS options, j.result_json AS result,
  j.error_code AS "errorCode", j.attempts, j.created_by::text AS "createdBy",
  j.tenant_id::text AS "tenantId", j.organization_id::text AS "organizationId",
  j.request_hash AS "requestHash", j.created_at AS "createdAt", j.updated_at AS "updatedAt"`;

/** Public job shape: internal fields (hash, tenant/org, attempts) are not exposed. */
export const toApiJob = (j: JobRow) => ({
  id: j.id,
  templateId: j.templateId,
  versionId: j.versionId,
  websiteId: j.websiteId,
  status: j.status,
  mode: j.options.mode,
  includeTheme: j.options.includeTheme,
  result: j.result,
  errorCode: j.errorCode,
  createdAt: j.createdAt,
  updatedAt: j.updatedAt,
});

export async function insertJob(
  db: Db,
  p: {
    tenantId: string; organizationId: string; websiteId: string; templateId: string; versionId: string;
    idempotencyKey: string; requestHash: string; options: unknown; createdBy: string;
  },
): Promise<string | null> {
  const { rows } = await db.query(
    `INSERT INTO template_apply_jobs
       (tenant_id, organization_id, website_id, template_id, version_id, status, idempotency_key,
        request_hash, request_json, created_by)
     VALUES ($1::bigint, $2::bigint, $3::bigint, $4::bigint, $5::bigint, 'QUEUED', $6, $7, $8::jsonb, $9::bigint)
     ON CONFLICT (tenant_id, organization_id, idempotency_key) DO NOTHING
     RETURNING id::text AS id`,
    [p.tenantId, p.organizationId, p.websiteId, p.templateId, p.versionId, p.idempotencyKey, p.requestHash,
     JSON.stringify(p.options), p.createdBy],
  );
  return rows[0]?.id ?? null;
}

export async function findJobByKey(db: Db, tenantId: string, organizationId: string, key: string): Promise<JobRow | null> {
  const { rows } = await db.query<JobRow>(
    `SELECT ${COLS} FROM template_apply_jobs j
      WHERE j.tenant_id = $1::bigint AND j.organization_id = $2::bigint AND j.idempotency_key = $3`,
    [tenantId, organizationId, key],
  );
  return rows[0] ?? null;
}

export async function findJobScoped(db: Db, tenantId: string, organizationId: string, id: string): Promise<JobRow | null> {
  const { rows } = await db.query<JobRow>(
    `SELECT ${COLS} FROM template_apply_jobs j
      WHERE j.id = $3::bigint AND j.tenant_id = $1::bigint AND j.organization_id = $2::bigint`,
    [tenantId, organizationId, id],
  );
  return rows[0] ?? null;
}

export async function claimJob(db: Db, id: string): Promise<JobRow | null> {
  const { rows } = await db.query<JobRow>(
    `UPDATE template_apply_jobs j SET status = 'RUNNING', attempts = attempts + 1, updated_at = now()
      WHERE j.id = $1::bigint AND j.status IN ('QUEUED','RUNNING')
      RETURNING ${COLS}`,
    [id],
  );
  return rows[0] ?? null;
}

export async function finishJob(
  db: Db,
  id: string,
  outcome: { status: "SUCCEEDED"; result: unknown } | { status: "FAILED"; errorCode: string },
): Promise<void> {
  await db.query(
    `UPDATE template_apply_jobs
        SET status = $2, result_json = $3::jsonb, error_code = $4, updated_at = now()
      WHERE id = $1::bigint`,
    [
      id,
      outcome.status,
      outcome.status === "SUCCEEDED" ? JSON.stringify(outcome.result) : null,
      outcome.status === "FAILED" ? outcome.errorCode : null,
    ],
  );
}

export async function listIncompleteJobIds(db: Db): Promise<Array<{ id: string; tenantId: string; organizationId: string; createdBy: string }>> {
  const { rows } = await db.query(
    `SELECT id::text AS id, tenant_id::text AS "tenantId", organization_id::text AS "organizationId", created_by::text AS "createdBy"
       FROM template_apply_jobs WHERE status IN ('QUEUED','RUNNING') ORDER BY id LIMIT 500`,
  );
  return rows;
}

export async function loadVersionPayload(db: Db, versionId: string) {
  const { rows } = await db.query(
    "SELECT document_json AS document, theme_json AS theme FROM template_versions WHERE id = $1::bigint",
    [versionId],
  );
  return rows[0] as { document: { pages: unknown[] }; theme: Record<string, unknown> } | undefined;
}
