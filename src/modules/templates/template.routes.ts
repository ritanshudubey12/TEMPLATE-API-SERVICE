import { Router, type Request } from "express";
import type { AuditWriter } from "../../audit/audit.repository";
import { validationError } from "../../errors";
import { getCtx, send } from "../../http";
import { parseId } from "../../ids";
import { requirePermission } from "../../middleware/require-permission";
import { validate } from "../../middleware/validate";
import type { Permission } from "../../types";
import type { ApplyService } from "../apply-jobs/apply.service";
import type { VersionService } from "../versions/version.service";
import type { TemplateService } from "./template.service";
import {
  applyBody, archiveBody, createTemplateBody, createVersionBody, duplicateBody, idempotencyKeySchema,
  listQuery, previewBody, publishBody, updateTemplateBody,
} from "./template.schemas";

type Deps = { templates: TemplateService; versions: VersionService; apply: ApplyService; audit: AuditWriter };

function idempotencyKey(req: Request): string {
  const r = idempotencyKeySchema.safeParse(req.header("idempotency-key"));
  if (!r.success) {
    throw validationError("A valid Idempotency-Key header is required.", [{ path: "Idempotency-Key", message: r.error.issues[0]?.message ?? "invalid" }]);
  }
  return r.data;
}

/** All /api/v1 routes. Authentication has already run; each route checks its permission, then validates input. */
export function createApiRouter({ templates, versions, apply, audit }: Deps): Router {
  const r = Router();
  const need = (p: Permission) => requirePermission(p, audit);
  const templateId = (req: Request) => parseId(req.params["templateId"], "templateId");

  r.get("/templates", need("template:read"), async (req, res) => {
    const query = validate(listQuery, req.query);
    const { items, nextCursor } = await templates.list(getCtx(res), query);
    send(res, 200, items, { limit: query.limit, nextCursor });
  });

  r.post("/templates", need("template:create"), async (req, res) => {
    send(res, 201, await templates.create(getCtx(res), validate(createTemplateBody, req.body)));
  });

  r.get("/templates/:templateId", need("template:read"), async (req, res) => {
    send(res, 200, await templates.get(getCtx(res), templateId(req)));
  });

  r.patch("/templates/:templateId", need("template:update"), async (req, res) => {
    const id = templateId(req);
    send(res, 200, await templates.update(getCtx(res), id, validate(updateTemplateBody, req.body)));
  });

  r.get("/templates/:templateId/versions", need("template:read"), async (req, res) => {
    send(res, 200, await versions.list(getCtx(res), templateId(req)));
  });

  r.post("/templates/:templateId/versions", need("template:update"), async (req, res) => {
    const id = templateId(req);
    send(res, 201, await versions.create(getCtx(res), id, validate(createVersionBody, req.body)));
  });

  r.get("/templates/:templateId/versions/:versionId", need("template:read"), async (req, res) => {
    const id = templateId(req);
    send(res, 200, await versions.get(getCtx(res), id, parseId(req.params["versionId"], "versionId")));
  });

  r.post("/templates/:templateId/publish", need("template:publish"), async (req, res) => {
    const id = templateId(req);
    send(res, 200, await templates.publish(getCtx(res), id, validate(publishBody, req.body)));
  });

  r.post("/templates/:templateId/archive", need("template:archive"), async (req, res) => {
    const id = templateId(req);
    send(res, 200, await templates.archive(getCtx(res), id, validate(archiveBody, req.body)));
  });

  r.post("/templates/:templateId/duplicate", need("template:create"), async (req, res) => {
    const id = templateId(req);
    const key = idempotencyKey(req);
    const out = await templates.duplicate(getCtx(res), id, validate(duplicateBody, req.body), key);
    send(res, out.status, out.body);
  });

  r.post("/templates/:templateId/preview-token", need("template:read"), async (req, res) => {
    const id = templateId(req);
    send(res, 201, await templates.createPreviewToken(getCtx(res), id, validate(previewBody, req.body)));
  });

  r.post("/templates/:templateId/apply", need("template:apply"), async (req, res) => {
    const id = templateId(req);
    const key = idempotencyKey(req);
    const { job } = await apply.enqueue(getCtx(res), id, key, validate(applyBody, req.body));
    res.setHeader("Location", `/api/v1/template-apply-jobs/${job.id}`);
    send(res, 202, { jobId: job.id, status: job.status });
  });

  r.get("/template-apply-jobs/:jobId", need("template:read"), async (req, res) => {
    send(res, 200, await apply.getJob(getCtx(res), parseId(req.params["jobId"], "jobId")));
  });

  return r;
}

