import type { Db } from "../../db/pool";
import { isAdmin, type RequestContext } from "../../types";
import type { ListQuery } from "./template.schemas";

export type TemplateRow = {
  id: string;
  scope: "PLATFORM" | "TENANT" | "ORGANIZATION";
  tenantId: string | null;
  organizationId: string | null;
  slug: string;
  name: string;
  description: string | null;
  category: string | null;
  visibility: "PRIVATE" | "TENANT" | "ORGANIZATION" | "PUBLIC";
  status: "DRAFT" | "PUBLISHED" | "ARCHIVED";
  currentPublishedVersionId: string | null;
  createdBy: string;
  updatedBy: string;
  createdAt: Date;
  updatedAt: Date;
  tags: string[];
  writable: boolean;
};

// Every statement below is scoped with the same three parameters: $1 tenant, $2 organization, $3 isPlatformAdmin.
const COLS = `
  t.id::text AS id, t.scope, t.tenant_id::text AS "tenantId", t.organization_id::text AS "organizationId",
  t.slug, t.name, t.description, c.slug AS category, t.visibility, t.status,
  t.current_published_version_id::text AS "currentPublishedVersionId",
  t.created_by::text AS "createdBy", t.updated_by::text AS "updatedBy",
  t.created_at AS "createdAt", t.updated_at AS "updatedAt",
  COALESCE((SELECT json_agg(tg.slug ORDER BY tg.slug)
              FROM template_tag_links l JOIN template_tags tg ON tg.id = l.tag_id
             WHERE l.template_id = t.id), '[]'::json) AS tags`;

const FROM = `FROM templates t LEFT JOIN template_categories c ON c.id = t.category_id`;

const VISIBLE = `t.deleted_at IS NULL AND (
     (t.tenant_id = $1::bigint AND t.organization_id = $2::bigint)
  OR (t.scope = 'TENANT' AND t.tenant_id = $1::bigint)
  OR (t.tenant_id = $1::bigint AND t.visibility = 'TENANT' AND t.status = 'PUBLISHED')
  OR (t.visibility = 'PUBLIC' AND t.status = 'PUBLISHED')
  OR (t.scope = 'PLATFORM' AND $3::boolean))`;

const WRITABLE = `(
     (t.scope = 'ORGANIZATION' AND t.tenant_id = $1::bigint AND t.organization_id = $2::bigint)
  OR (t.scope = 'TENANT' AND t.tenant_id = $1::bigint)
  OR (t.scope = 'PLATFORM' AND $3::boolean))`;

export const scopeArgs = (ctx: RequestContext): [string, string, boolean] => [
  ctx.tenantId.toString(),
  ctx.organizationId.toString(),
  isAdmin(ctx),
];

export const toApiTemplate = ({ writable: _writable, ...rest }: TemplateRow) => rest;

/** Loads a template only if it is visible to the caller's tenant/org scope. */
export async function findVisible(db: Db, ctx: RequestContext, id: string, lock = false): Promise<TemplateRow | null> {
  const { rows } = await db.query<TemplateRow>(
    `SELECT ${COLS}, ${WRITABLE} AS writable ${FROM}
      WHERE t.id = $4::bigint AND ${VISIBLE} ${lock ? "FOR UPDATE OF t" : ""}`,
    [...scopeArgs(ctx), id],
  );
  return rows[0] ?? null;
}

export async function listVisible(db: Db, ctx: RequestContext, q: ListQuery, limit: number): Promise<TemplateRow[]> {
  const params: unknown[] = [...scopeArgs(ctx)];
  const where: string[] = [VISIBLE];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    where.push(sql.replaceAll("?", `$${params.length}`));
  };

  if (q.q) add(`(t.name ILIKE ? OR t.slug ILIKE ?)`, `%${q.q.replace(/[\\%_]/g, "\\$&")}%`);
  if (q.category) add(`c.slug = ?`, q.category);
  if (q.tag) {
    add(
      `EXISTS (SELECT 1 FROM template_tag_links l JOIN template_tags tg ON tg.id = l.tag_id WHERE l.template_id = t.id AND tg.slug = ?)`,
      q.tag,
    );
  }
  if (q.status) add(`t.status = ?`, q.status);
  else where.push(`t.status <> 'ARCHIVED'`);
  if (q.scope) add(`t.scope = ?`, q.scope);
  if (q.cursor) add(`t.id < ?::bigint`, q.cursor);

  params.push(limit);
  const { rows } = await db.query<TemplateRow>(
    `SELECT ${COLS}, ${WRITABLE} AS writable ${FROM}
      WHERE ${where.join(" AND ")} ORDER BY t.id DESC LIMIT $${params.length}`,
    params,
  );
  return rows;
}

export async function findCategoryId(db: Db, slug: string): Promise<string | null> {
  const { rows } = await db.query("SELECT id::text AS id FROM template_categories WHERE slug = $1 AND active", [slug]);
  return rows[0]?.id ?? null;
}

export async function insertTemplate(
  db: Db,
  p: {
    scope: string; tenantId: string | null; organizationId: string | null; slug: string; name: string;
    description: string | null; categoryId: string; visibility: string; userId: string;
  },
): Promise<string> {
  const { rows } = await db.query(
    `INSERT INTO templates
       (scope, tenant_id, organization_id, slug, name, description, category_id, visibility, status, created_by, updated_by)
     VALUES ($1, $2::bigint, $3::bigint, $4, $5, $6, $7::bigint, $8, 'DRAFT', $9::bigint, $9::bigint)
     RETURNING id::text AS id`,
    [p.scope, p.tenantId, p.organizationId, p.slug, p.name, p.description, p.categoryId, p.visibility, p.userId],
  );
  return rows[0].id;
}

export async function updateTemplate(
  db: Db,
  id: string,
  userId: string,
  patch: { name?: string; description?: string | null; categoryId?: string; visibility?: string },
): Promise<void> {
  const sets: string[] = ["updated_by = $2::bigint", "updated_at = now()"];
  const params: unknown[] = [id, userId];
  const set = (col: string, cast: string, value: unknown) => {
    params.push(value);
    sets.push(`${col} = $${params.length}${cast}`);
  };
  if (patch.name !== undefined) set("name", "", patch.name);
  if (patch.description !== undefined) set("description", "", patch.description);
  if (patch.categoryId !== undefined) set("category_id", "::bigint", patch.categoryId);
  if (patch.visibility !== undefined) set("visibility", "", patch.visibility);
  await db.query(`UPDATE templates SET ${sets.join(", ")} WHERE id = $1::bigint`, params);
}

export async function setPublished(db: Db, id: string, versionId: string, userId: string): Promise<void> {
  await db.query(
    `UPDATE templates SET status = 'PUBLISHED', current_published_version_id = $2::bigint,
            updated_by = $3::bigint, updated_at = now() WHERE id = $1::bigint`,
    [id, versionId, userId],
  );
}

export async function setArchived(db: Db, id: string, userId: string): Promise<void> {
  await db.query(
    `UPDATE templates SET status = 'ARCHIVED', updated_by = $2::bigint, updated_at = now() WHERE id = $1::bigint`,
    [id, userId],
  );
}

/** Replaces the template's tags. Tags are namespaced by the template's owning tenant/organization. */
export async function replaceTags(
  db: Db,
  templateId: string,
  owner: { tenantId: string | null; organizationId: string | null },
  tags: string[],
): Promise<void> {
  await db.query("DELETE FROM template_tag_links WHERE template_id = $1::bigint", [templateId]);
  for (const slug of new Set(tags)) {
    const { rows } = await db.query(
      `INSERT INTO template_tags (tenant_id, organization_id, slug, label)
       VALUES ($1::bigint, $2::bigint, $3, $3)
       ON CONFLICT (COALESCE(tenant_id, 0), COALESCE(organization_id, 0), slug) DO UPDATE SET label = EXCLUDED.label
       RETURNING id::text AS id`,
      [owner.tenantId, owner.organizationId, slug],
    );
    await db.query(
      "INSERT INTO template_tag_links (template_id, tag_id) VALUES ($1::bigint, $2::bigint) ON CONFLICT DO NOTHING",
      [templateId, rows[0].id],
    );
  }
}
