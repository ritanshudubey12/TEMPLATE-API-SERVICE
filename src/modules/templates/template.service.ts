import type { Pool } from "pg";
import { SignJWT } from "jose";
import { auditFromCtx, insertAudit } from "../../audit/audit.repository";
import { withTransaction } from "../../db/pool";
import { conflict, forbidden, isUniqueViolation, notFound, validationError } from "../../errors";
import { enqueueEvent } from "../../events/outbox.repository";
import { isAdmin, type RequestContext } from "../../types";
import {
  getVersion, insertVersion, latestVersionId, markVersionPublished,
} from "../versions/version.repository";
import { completeIdempotent, beginIdempotent } from "./idempotency.repository";
import {
  findCategoryId, findVisible, insertTemplate, listVisible, replaceTags, setArchived, setPublished,
  toApiTemplate, updateTemplate, type TemplateRow,
} from "./template.repository";
import { sha256, type CreateTemplateInput, type DuplicateInput, type ListQuery, type UpdateTemplateInput } from "./template.schemas";

const PREVIEW_TTL_SECONDS = 300;

function ownerFor(scope: string, ctx: RequestContext) {
  return {
    tenantId: scope === "PLATFORM" ? null : ctx.tenantId.toString(),
    organizationId: scope === "ORGANIZATION" ? ctx.organizationId.toString() : null,
  };
}

function assertMayCreateIn(ctx: RequestContext, scope: string, visibility: string) {
  if (scope === "PLATFORM" && !isAdmin(ctx)) throw forbidden("Only platform administrators can manage the platform catalog.");
  if (visibility === "PUBLIC" && !isAdmin(ctx)) throw forbidden("Only platform administrators can make a template PUBLIC.");
}

async function requireCategory(c: Pool | import("pg").PoolClient, slug: string): Promise<string> {
  const id = await findCategoryId(c, slug);
  if (!id) throw validationError("Unknown category.", [{ path: "category", message: `category "${slug}" does not exist` }]);
  return id;
}

export function createTemplateService(deps: { pool: Pool; previewSecret: string }) {
  const { pool } = deps;

  async function loadWritable(c: import("pg").PoolClient, ctx: RequestContext, id: string): Promise<TemplateRow> {
    const tpl = await findVisible(c, ctx, id, true);
    if (!tpl) throw notFound("Template not found.");
    if (!tpl.writable) throw forbidden("You cannot modify this template.");
    return tpl;
  }

  return {
    async create(ctx: RequestContext, input: CreateTemplateInput) {
      assertMayCreateIn(ctx, input.scope, input.visibility);
      return withTransaction(pool, async (c) => {
        const categoryId = await requireCategory(c, input.category);
        const owner = ownerFor(input.scope, ctx);
        let id: string;
        try {
          id = await insertTemplate(c, {
            scope: input.scope, ...owner, slug: input.slug, name: input.name,
            description: input.description ?? null, categoryId, visibility: input.visibility,
            userId: ctx.userId.toString(),
          });
        } catch (err) {
          if (isUniqueViolation(err)) throw conflict("A template with this slug already exists in this scope.");
          throw err;
        }
        await replaceTags(c, id, owner, input.tags);
        await insertAudit(c, auditFromCtx(ctx, "template.create", "template", id, { slug: input.slug, scope: input.scope }));
        await enqueueEvent(c, "template.created", { templateId: id, scope: input.scope, tenantId: ctx.tenantId.toString() });
        return toApiTemplate((await findVisible(c, ctx, id))!);
      });
    },

    async list(ctx: RequestContext, query: ListQuery) {
      const rows = await listVisible(pool, ctx, query, query.limit + 1);
      const page = rows.slice(0, query.limit);
      return {
        items: page.map(toApiTemplate),
        nextCursor: rows.length > query.limit ? (page[page.length - 1]?.id ?? null) : null,
      };
    },

    async get(ctx: RequestContext, id: string) {
      const tpl = await findVisible(pool, ctx, id);
      if (!tpl) throw notFound("Template not found.");
      return toApiTemplate(tpl);
    },

    async update(ctx: RequestContext, id: string, patch: UpdateTemplateInput) {
      if (patch.visibility === "PUBLIC" && !isAdmin(ctx)) throw forbidden("Only platform administrators can make a template PUBLIC.");
      return withTransaction(pool, async (c) => {
        const tpl = await loadWritable(c, ctx, id);
        if (tpl.status === "ARCHIVED") throw conflict("Archived templates cannot be modified.");
        const categoryId = patch.category ? await requireCategory(c, patch.category) : undefined;
        await updateTemplate(c, id, ctx.userId.toString(), {
          name: patch.name, description: patch.description, categoryId, visibility: patch.visibility,
        });
        if (patch.tags) {
          await replaceTags(c, id, { tenantId: tpl.tenantId, organizationId: tpl.organizationId }, patch.tags);
        }
        await insertAudit(c, auditFromCtx(ctx, "template.update", "template", id, { fields: Object.keys(patch) }));
        await enqueueEvent(c, "template.updated", { templateId: id, tenantId: ctx.tenantId.toString() });
        return toApiTemplate((await findVisible(c, ctx, id))!);
      });
    },

    async publish(ctx: RequestContext, id: string, input: { versionId?: string }) {
      return withTransaction(pool, async (c) => {
        const tpl = await loadWritable(c, ctx, id);
        if (tpl.status === "ARCHIVED") throw conflict("Archived templates cannot be published.");

        const versionId = input.versionId ?? (await latestVersionId(c, id, "DRAFT"));
        if (!versionId) throw conflict("There is no draft version to publish.");
        const version = await getVersion(c, id, versionId, { onlyPublished: false, withDocument: false });
        if (!version) throw notFound("Version not found.");
        if (version.status !== "DRAFT") throw conflict("Only a DRAFT version can be published.");

        await markVersionPublished(c, versionId);
        await setPublished(c, id, versionId, ctx.userId.toString());
        await insertAudit(c, auditFromCtx(ctx, "template.publish", "template", id, { versionId }));
        await enqueueEvent(c, "template.published", { templateId: id, versionId, tenantId: ctx.tenantId.toString() });
        return {
          template: toApiTemplate((await findVisible(c, ctx, id))!),
          version: (await getVersion(c, id, versionId, { onlyPublished: false, withDocument: false }))!,
        };
      });
    },

    async archive(ctx: RequestContext, id: string, input: { reason?: string }) {
      return withTransaction(pool, async (c) => {
        const tpl = await loadWritable(c, ctx, id);
        if (tpl.status !== "ARCHIVED") {
          await setArchived(c, id, ctx.userId.toString());
          await insertAudit(c, auditFromCtx(ctx, "template.archive", "template", id, { reason: input.reason ?? null }));
          await enqueueEvent(c, "template.archived", { templateId: id, tenantId: ctx.tenantId.toString() });
        }
        return toApiTemplate((await findVisible(c, ctx, id))!);
      });
    },

    /** Copies one version of a visible template into a new DRAFT template. Safe to retry with the same Idempotency-Key. */
    async duplicate(ctx: RequestContext, id: string, input: DuplicateInput, idempotencyKey: string) {
      const scope = input.scope ?? "ORGANIZATION";
      const visibility = input.visibility ?? "PRIVATE";
      assertMayCreateIn(ctx, scope, visibility);

      return withTransaction(pool, async (c) => {
        const replay = await beginIdempotent(c, ctx, "template.duplicate", idempotencyKey, sha256({ id, input }));
        if (replay) return replay;

        const source = await findVisible(c, ctx, id);
        if (!source) throw notFound("Template not found.");

        const versionId =
          input.versionId ??
          source.currentPublishedVersionId ??
          (source.writable ? await latestVersionId(c, id) : null);
        if (!versionId) throw conflict("The source template has no version to duplicate.");
        const sourceVersion = await getVersion(c, id, versionId, { onlyPublished: !source.writable, withDocument: true });
        if (!sourceVersion) throw notFound("Version not found.");

        const owner = ownerFor(scope, ctx);
        const categoryId = await requireCategory(c, source.category ?? "general");
        let newId: string;
        try {
          newId = await insertTemplate(c, {
            scope, ...owner,
            slug: input.slug ?? `${source.slug}-copy`.slice(0, 80),
            name: input.name ?? `${source.name} (Copy)`.slice(0, 200),
            description: source.description, categoryId, visibility, userId: ctx.userId.toString(),
          });
        } catch (err) {
          if (isUniqueViolation(err)) throw conflict("A template with this slug already exists in the target scope.");
          throw err;
        }
        await replaceTags(c, newId, owner, source.tags);
        const newVersionId = await insertVersion(c, {
          templateId: newId,
          schemaVersion: sourceVersion.schemaVersion,
          document: sourceVersion.document,
          theme: sourceVersion.theme ?? {},
          requiredFeatures: sourceVersion.requiredFeatures,
          previewAssetId: sourceVersion.previewAssetId,
          checksum: sourceVersion.checksum,
          createdBy: ctx.userId.toString(),
        });
        await insertAudit(c, auditFromCtx(ctx, "template.duplicate", "template", newId, { sourceTemplateId: id, sourceVersionId: versionId }));
        await enqueueEvent(c, "template.duplicated", { templateId: newId, sourceTemplateId: id, tenantId: ctx.tenantId.toString() });

        const { document: _d, theme: _t, ...versionSummary } = (await getVersion(c, newId, newVersionId, { onlyPublished: false, withDocument: true }))!;
        const body = { template: toApiTemplate((await findVisible(c, ctx, newId))!), version: versionSummary };
        const response = JSON.parse(JSON.stringify(body));
        await completeIdempotent(c, ctx, "template.duplicate", idempotencyKey, 201, response);
        return { status: 201, body: response };
      });
    },

    /** Short-lived, scoped token a preview renderer can present; it is NOT an access token for this API. */
    async createPreviewToken(ctx: RequestContext, id: string, input: { versionId?: string }) {
      const tpl = await findVisible(pool, ctx, id);
      if (!tpl) throw notFound("Template not found.");
      const versionId =
        input.versionId ?? tpl.currentPublishedVersionId ?? (tpl.writable ? await latestVersionId(pool, id) : null);
      if (!versionId) throw conflict("The template has no version to preview.");
      const version = await getVersion(pool, id, versionId, { onlyPublished: !tpl.writable, withDocument: false });
      if (!version) throw notFound("Version not found.");

      const now = Math.floor(Date.now() / 1000);
      const token = await new SignJWT({ tpl: id, ver: versionId, ten: ctx.tenantId.toString(), org: ctx.organizationId.toString() })
        .setProtectedHeader({ alg: "HS256" })
        .setAudience("template-preview")
        .setSubject(ctx.userId.toString())
        .setIssuedAt(now)
        .setExpirationTime(now + PREVIEW_TTL_SECONDS)
        .sign(new TextEncoder().encode(deps.previewSecret));
      return {
        token,
        templateId: id,
        versionId,
        expiresInSeconds: PREVIEW_TTL_SECONDS,
        expiresAt: new Date((now + PREVIEW_TTL_SECONDS) * 1000).toISOString(),
      };
    },
  };
}

export type TemplateService = ReturnType<typeof createTemplateService>;
