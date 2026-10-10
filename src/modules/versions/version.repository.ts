import type { Db } from "../../db/pool";

export type VersionRow = {
  id: string;
  templateId: string;
  versionNumber: number;
  schemaVersion: number;
  requiredFeatures: unknown[];
  previewAssetId: string | null;
  checksum: string;
  status: "DRAFT" | "PUBLISHED" | "ARCHIVED";
  createdBy: string;
  createdAt: Date;
  publishedAt: Date | null;
  document?: unknown;
  theme?: unknown;
};

const COLS = `
  v.id::text AS id, v.template_id::text AS "templateId", v.version_number AS "versionNumber",
  v.schema_version AS "schemaVersion", v.required_features AS "requiredFeatures",
  v.preview_asset_id::text AS "previewAssetId", v.checksum, v.status,
  v.created_by::text AS "createdBy", v.created_at AS "createdAt", v.published_at AS "publishedAt"`;
const DOC_COLS = `${COLS}, v.document_json AS document, v.theme_json AS theme`;

export async function insertVersion(
  db: Db,
  p: {
    templateId: string; schemaVersion: number; document: unknown; theme: unknown;
    requiredFeatures: unknown[]; previewAssetId: string | null; checksum: string; createdBy: string;
  },
): Promise<string> {
  // Callers hold a row lock on the parent template, so MAX()+1 cannot race.
  const { rows } = await db.query(
    `INSERT INTO template_versions
       (template_id, version_number, schema_version, document_json, theme_json, required_features,
        preview_asset_id, checksum, status, created_by)
     VALUES ($1::bigint,
             (SELECT COALESCE(MAX(version_number), 0) + 1 FROM template_versions WHERE template_id = $1::bigint),
             $2, $3::jsonb, $4::jsonb, $5::jsonb, $6::bigint, $7, 'DRAFT', $8::bigint)
     RETURNING id::text AS id`,
    [p.templateId, p.schemaVersion, JSON.stringify(p.document), JSON.stringify(p.theme),
     JSON.stringify(p.requiredFeatures), p.previewAssetId, p.checksum, p.createdBy],
  );
  return rows[0].id;
}

export async function getVersion(
  db: Db,
  templateId: string,
  versionId: string,
  opts: { onlyPublished: boolean; withDocument: boolean },
): Promise<VersionRow | null> {
  const { rows } = await db.query<VersionRow>(
    `SELECT ${opts.withDocument ? DOC_COLS : COLS} FROM template_versions v
      WHERE v.id = $1::bigint AND v.template_id = $2::bigint ${opts.onlyPublished ? "AND v.status = 'PUBLISHED'" : ""}`,
    [versionId, templateId],
  );
  return rows[0] ?? null;
}

export async function listVersions(db: Db, templateId: string, onlyPublished: boolean): Promise<VersionRow[]> {
  const { rows } = await db.query<VersionRow>(
    `SELECT ${COLS} FROM template_versions v
      WHERE v.template_id = $1::bigint ${onlyPublished ? "AND v.status = 'PUBLISHED'" : ""}
      ORDER BY v.version_number DESC`,
    [templateId],
  );
  return rows;
}

export async function latestVersionId(db: Db, templateId: string, status?: "DRAFT" | "PUBLISHED"): Promise<string | null> {
  const { rows } = await db.query(
    `SELECT id::text AS id FROM template_versions
      WHERE template_id = $1::bigint ${status ? "AND status = $2" : ""}
      ORDER BY version_number DESC LIMIT 1`,
    status ? [templateId, status] : [templateId],
  );
  return rows[0]?.id ?? null;
}

export async function markVersionPublished(db: Db, versionId: string): Promise<void> {
  await db.query(
    "UPDATE template_versions SET status = 'PUBLISHED', published_at = now() WHERE id = $1::bigint AND status = 'DRAFT'",
    [versionId],
  );
}
