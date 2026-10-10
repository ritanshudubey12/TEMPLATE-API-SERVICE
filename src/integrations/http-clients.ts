import type { JWTPayload } from "jose";
import type { Config } from "../config/env";
import { AppError } from "../errors";
import { bigIdSchema } from "../ids";
import type { RequestContext } from "../types";
import type { CallContext, Clients, DraftPageResult, IdentityClient } from "./types";

// NOTE: the downstream paths and payloads below are the contract this service ASSUMES.
// Adjust them to the real Website/Page/Theme/Media/Identity APIs before using INTEGRATIONS_MODE=http.

type CallOptions = { method?: string; body?: unknown; headers?: Record<string, string>; token?: string; requestId: string };

async function callJson(baseUrl: string, path: string, opts: CallOptions): Promise<any> {
  let res: Response;
  try {
    res = await fetch(new URL(path, baseUrl), {
      method: opts.method ?? "GET",
      headers: {
        accept: "application/json",
        ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        "x-request-id": opts.requestId,
        ...opts.headers,
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new AppError(502, "UPSTREAM_UNAVAILABLE", "A dependent service could not be reached.");
  }
  if (res.status === 401 || res.status === 403) throw new AppError(403, "FORBIDDEN", "Access denied by a dependent service.");
  if (res.status === 404) throw new AppError(404, "NOT_FOUND", "Resource not found in a dependent service.");
  if (res.status === 409) throw new AppError(409, "REVISION_CONFLICT", "A dependent service reported a conflict.");
  if (!res.ok) throw new AppError(502, "UPSTREAM_ERROR", `A dependent service responded ${res.status}.`);
  return res.status === 204 ? null : res.json();
}

export function createHttpIdentityClient(config: Config): IdentityClient {
  return {
    async resolveContext(_payload: JWTPayload, accessToken: string, requestId: string): Promise<RequestContext> {
      const body = await callJson(config.IDENTITY_API_URL!, "/api/v1/me/context", { token: accessToken, requestId });
      const d = body?.data ?? {};
      const ids = [d.userId, d.tenantId, d.organizationId].map((v) => bigIdSchema.safeParse(v));
      if (ids.some((r) => !r.success)) throw new AppError(403, "FORBIDDEN", "No active tenant/organization membership.");
      return {
        userId: BigInt(d.userId),
        tenantId: BigInt(d.tenantId),
        organizationId: BigInt(d.organizationId),
        roles: Array.isArray(d.roles) ? d.roles : [],
        permissions: Array.isArray(d.permissions) ? d.permissions : [],
        requestId,
        accessToken,
      };
    },
  };
}

export function createHttpClients(config: Config): Clients {
  const token = (c: CallContext) => c.accessToken ?? config.INTEGRATIONS_SERVICE_TOKEN;
  return {
    website: {
      async getWebsite(websiteId, c) {
        const body = await callJson(config.WEBSITE_API_URL!, `/api/v1/websites/${websiteId}`, { token: token(c), requestId: c.requestId });
        return { id: String(body.data.id), revision: Number(body.data.revision) };
      },
    },
    page: {
      async createDraftPages({ websiteId, idempotencyKey, pages }, c) {
        const body = await callJson(config.PAGE_API_URL!, `/api/v1/websites/${websiteId}/draft-pages`, {
          method: "POST",
          body: { pages },
          headers: { "idempotency-key": idempotencyKey },
          token: token(c),
          requestId: c.requestId,
        });
        return body.data.pages as DraftPageResult[];
      },
    },
    theme: {
      async applyTheme({ websiteId, idempotencyKey, theme }, c) {
        await callJson(config.THEME_API_URL!, `/api/v1/websites/${websiteId}/draft-theme`, {
          method: "PUT",
          body: { theme },
          headers: { "idempotency-key": idempotencyKey },
          token: token(c),
          requestId: c.requestId,
        });
      },
    },
    media: {
      async findInaccessibleAssets(assetIds, c) {
        if (assetIds.length === 0) return [];
        const body = await callJson(config.MEDIA_API_URL!, "/api/v1/assets/validate-access", {
          method: "POST",
          body: { assetIds },
          token: token(c),
          requestId: c.requestId,
        });
        return (body.data.inaccessibleAssetIds ?? []) as string[];
      },
    },
  };
}
