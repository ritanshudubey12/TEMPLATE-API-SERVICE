import type { Pool } from "pg";
import type { AuditWriter } from "./audit/audit.repository";
import type { Config } from "./config/env";
import type { Clients } from "./integrations/types";
import type { Logger } from "./observability/logger";
import { createApplyService } from "./modules/apply-jobs/apply.service";
import { createTemplateService } from "./modules/templates/template.service";
import { createVersionService } from "./modules/versions/version.service";

export function createTemplateRouterDeps(d: { config: Config; pool: Pool; logger: Logger; clients: Clients; audit: AuditWriter }) {
  return {
    audit: d.audit,
    templates: createTemplateService({ pool: d.pool, previewSecret: d.config.PREVIEW_TOKEN_SECRET }),
    versions: createVersionService({ pool: d.pool, maxDocumentBytes: d.config.TEMPLATE_MAX_DOCUMENT_BYTES }),
    apply: createApplyService({
      pool: d.pool, clients: d.clients, logger: d.logger, timeoutMs: d.config.TEMPLATE_APPLY_JOB_TIMEOUT_MS,
    }),
  };
}
