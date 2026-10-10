import type { Pool } from "pg";
import { auditFromCtx, insertAudit } from "../../audit/audit.repository";
import { withTransaction } from "../../db/pool";
import { AppError, conflict, forbidden, notFound } from "../../errors";
import { enqueueEvent } from "../../events/outbox.repository";
import type { RequestContext } from "../../types";
import { findVisible } from "../templates/template.repository";
import { sha256, type CreateVersionInput } from "../templates/template.schemas";
import { getVersion, insertVersion, listVersions } from "./version.repository";

export function createVersionService(deps: { pool: Pool; maxDocumentBytes: number }) {
  const { pool, maxDocumentBytes } = deps;

  return {
    async create(ctx: RequestContext, templateId: string, input: CreateVersionInput) {
      const size = Buffer.byteLength(JSON.stringify(input.document), "utf8");
      if (size > maxDocumentBytes) {
        throw new AppError(413, "PAYLOAD_TOO_LARGE", `Template document exceeds ${maxDocumentBytes} bytes.`);
      }

      return withTransaction(pool, async (c) => {
        const tpl = await findVisible(c, ctx, templateId, true);
        if (!tpl) throw notFound("Template not found.");
        if (!tpl.writable) throw forbidden("You cannot modify this template.");
        if (tpl.status === "ARCHIVED") throw conflict("Archived templates cannot receive new versions.");

        const versionId = await insertVersion(c, {
          templateId,
          schemaVersion: input.document.schemaVersion,
          document: input.document,
          theme: input.theme,
          requiredFeatures: input.requiredFeatures,
          previewAssetId: input.previewAssetId ?? null,
          checksum: sha256({ document: input.document, theme: input.theme }),
          createdBy: ctx.userId.toString(),
        });
        await insertAudit(c, auditFromCtx(ctx, "template.version.create", "template_version", versionId, { templateId }));
        await enqueueEvent(c, "template.version.created", { templateId, versionId, tenantId: ctx.tenantId.toString() });
        return (await getVersion(c, templateId, versionId, { onlyPublished: false, withDocument: true }))!;
      });
    },

    async list(ctx: RequestContext, templateId: string) {
      const tpl = await findVisible(pool, ctx, templateId);
      if (!tpl) throw notFound("Template not found.");
      // Callers who cannot edit the template only see published (immutable) versions.
      return listVersions(pool, templateId, !tpl.writable);
    },

    async get(ctx: RequestContext, templateId: string, versionId: string) {
      const tpl = await findVisible(pool, ctx, templateId);
      if (!tpl) throw notFound("Template not found.");
      const version = await getVersion(pool, templateId, versionId, { onlyPublished: !tpl.writable, withDocument: true });
      if (!version) throw notFound("Version not found.");
      return version;
    },
  };
}

export type VersionService = ReturnType<typeof createVersionService>;
