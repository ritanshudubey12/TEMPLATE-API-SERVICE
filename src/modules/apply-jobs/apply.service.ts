import type { Pool } from "pg";
import { auditFromCtx, insertAudit, type AuditEntry } from "../../audit/audit.repository";
import { withTransaction } from "../../db/pool";
import { AppError, conflict, notFound } from "../../errors";
import { enqueueEvent } from "../../events/outbox.repository";
import type { CallContext, Clients } from "../../integrations/types";
import type { Logger } from "../../observability/logger";
import type { RequestContext } from "../../types";
import { collectAssetIds, type TemplateDocument } from "../templates/document.schema";
import { findVisible } from "../templates/template.repository";
import { sha256, type ApplyInput } from "../templates/template.schemas";
import { getVersion } from "../versions/version.repository";
import {
  claimJob, finishJob, findJobByKey, findJobScoped, insertJob, listIncompleteJobIds, loadVersionPayload, toApiJob, type JobRow,
} from "./apply-job.repository";

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AppError(504, "APPLY_TIMEOUT", "Applying the template timed out.")), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

export function createApplyService(deps: { pool: Pool; clients: Clients; logger: Logger; timeoutMs: number }) {
  const { pool, clients, logger, timeoutMs } = deps;

  const callContext = (ctx: RequestContext): CallContext => ({
    requestId: ctx.requestId,
    tenantId: ctx.tenantId.toString(),
    organizationId: ctx.organizationId.toString(),
    userId: ctx.userId.toString(),
    accessToken: ctx.accessToken,
  });

  const jobAudit = (job: JobRow, action: string, metadata: Record<string, unknown>): AuditEntry => ({
    tenantId: job.tenantId,
    organizationId: job.organizationId,
    actorUserId: job.createdBy,
    action,
    resourceType: "template_apply_job",
    resourceId: job.id,
    requestId: null,
    metadata,
  });

  /**
   * Runs one job. Safe to call again for the same job (recovery/retry): downstream calls carry an idempotency key
   * derived from the job id. There is no cross-service transaction; a failed job ends in FAILED, never half-published.
   * Applying NEVER publishes: only draft pages are created.
   */
  async function process(jobId: string, call: CallContext): Promise<void> {
    const job = await claimJob(pool, jobId);
    if (!job) return;
    try {
      const payload = await loadVersionPayload(pool, job.versionId);
      if (!payload) throw new AppError(500, "VERSION_MISSING", "Template version no longer exists.");

      const result = await withTimeout(
        (async () => {
          const key = `apply-job-${job.id}`;
          const pages = await clients.page.createDraftPages({ websiteId: job.websiteId, idempotencyKey: key, pages: payload.document.pages }, call);
          let themeApplied = false;
          if (job.options.includeTheme && Object.keys(payload.theme ?? {}).length > 0) {
            await clients.theme.applyTheme({ websiteId: job.websiteId, idempotencyKey: `${key}-theme`, theme: payload.theme }, call);
            themeApplied = true;
          }
          return { pages, themeApplied, published: false };
        })(),
        timeoutMs,
      );

      await withTransaction(pool, async (c) => {
        await finishJob(c, job.id, { status: "SUCCEEDED", result });
        await insertAudit(c, jobAudit(job, "template.apply.succeeded", { websiteId: job.websiteId, pages: result.pages.length }));
        await enqueueEvent(c, "template.applied", { jobId: job.id, templateId: job.templateId, versionId: job.versionId, websiteId: job.websiteId, tenantId: job.tenantId });
      });
    } catch (err) {
      const errorCode = err instanceof AppError ? err.code : "APPLY_FAILED";
      logger.error({ jobId: job.id, errorCode, err: (err as Error).message }, "template apply job failed");
      await withTransaction(pool, async (c) => {
        await finishJob(c, job.id, { status: "FAILED", errorCode });
        await insertAudit(c, jobAudit(job, "template.apply.failed", { errorCode }));
        await enqueueEvent(c, "template.apply.failed", { jobId: job.id, templateId: job.templateId, errorCode, tenantId: job.tenantId });
      }).catch((e) => logger.error({ jobId: job.id, err: (e as Error).message }, "could not record job failure"));
    }
  }

  return {
    process,

    async enqueue(ctx: RequestContext, templateId: string, idempotencyKey: string, input: ApplyInput) {
      const tenantId = ctx.tenantId.toString();
      const organizationId = ctx.organizationId.toString();
      const requestHash = sha256({ templateId, input });

      const replayOrConflict = async () => {
        const existing = await findJobByKey(pool, tenantId, organizationId, idempotencyKey);
        if (!existing) return null;
        if (existing.requestHash !== requestHash) {
          throw conflict("This Idempotency-Key was already used with a different request.", "IDEMPOTENCY_CONFLICT");
        }
        return existing;
      };

      const replay = await replayOrConflict();
      if (replay) return { job: replay, replayed: true };

      const tpl = await findVisible(pool, ctx, templateId);
      if (!tpl) throw notFound("Template not found.");
      if (tpl.status === "ARCHIVED") throw conflict("Archived templates cannot be applied.");

      const versionId = input.versionId ?? tpl.currentPublishedVersionId;
      if (!versionId) throw conflict("The template has no published version to apply.");
      const version = await getVersion(pool, templateId, versionId, { onlyPublished: true, withDocument: true });
      if (!version) throw notFound("Published version not found.");

      const call = callContext(ctx);
      const website = await clients.website.getWebsite(input.websiteId, call);
      if (input.expectedWebsiteRevision !== undefined && website.revision !== input.expectedWebsiteRevision) {
        throw conflict("The website changed since it was loaded.", "REVISION_CONFLICT", {
          expected: input.expectedWebsiteRevision, actual: website.revision,
        });
      }

      const assetIds = collectAssetIds(version.document as TemplateDocument);
      if (assetIds.length > 0) {
        const blocked = await clients.media.findInaccessibleAssets(assetIds, call);
        if (blocked.length > 0) {
          throw new AppError(400, "MEDIA_ASSET_INACCESSIBLE", "Some media assets are not accessible to this organization.", { assetIds: blocked });
        }
      }

      const jobId = await withTransaction(pool, async (c) => {
        const id = await insertJob(c, {
          tenantId, organizationId, websiteId: input.websiteId, templateId, versionId, idempotencyKey, requestHash,
          options: { mode: input.mode, includeTheme: input.includeTheme, mediaPolicy: input.mediaPolicy, expectedWebsiteRevision: input.expectedWebsiteRevision },
          createdBy: ctx.userId.toString(),
        });
        if (!id) return null; // lost a race on the same key
        await insertAudit(c, auditFromCtx(ctx, "template.apply.queued", "template_apply_job", id, { templateId, versionId, websiteId: input.websiteId }));
        await enqueueEvent(c, "template.apply.queued", { jobId: id, templateId, versionId, websiteId: input.websiteId, tenantId });
        return id;
      });

      if (!jobId) {
        const raced = await replayOrConflict();
        return { job: raced!, replayed: true };
      }

      setImmediate(() => void process(jobId, call).catch((err) => logger.error({ jobId, err: (err as Error).message }, "apply job crashed")));
      const job = (await findJobScoped(pool, tenantId, organizationId, jobId))!;
      return { job, replayed: false };
    },

    async getJob(ctx: RequestContext, jobId: string) {
      const job = await findJobScoped(pool, ctx.tenantId.toString(), ctx.organizationId.toString(), jobId);
      if (!job) throw notFound("Apply job not found.");
      return toApiJob(job);
    },

    /** Re-runs QUEUED/RUNNING jobs left over from a crash or restart. */
    async recoverIncompleteJobs(serviceToken?: string): Promise<number> {
      const pending = await listIncompleteJobIds(pool);
      for (const j of pending) {
        void process(j.id, {
          requestId: `recover-${j.id}`, tenantId: j.tenantId, organizationId: j.organizationId, userId: j.createdBy,
          accessToken: serviceToken,
        });
      }
      return pending.length;
    },
  };
}

export type ApplyService = ReturnType<typeof createApplyService>;
