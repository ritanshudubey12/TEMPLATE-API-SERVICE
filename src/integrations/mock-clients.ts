import type { JWTPayload } from "jose";
import { AppError } from "../errors";
import { bigIdSchema } from "../ids";
import type { RequestContext } from "../types";
import type { Clients, DraftPageResult, IdentityClient } from "./types";

/** Every mock website reports this revision, so Postman/tests can send expectedWebsiteRevision: 7. */
export const MOCK_WEBSITE_REVISION = 7;

const asIdString = (v: unknown): string | null => {
  const r = bigIdSchema.safeParse(v);
  return r.success ? r.data : null;
};

/** Local stand-in for the Identity API: trusts the claims of an already-verified token. */
export function createMockIdentityClient(): IdentityClient {
  return {
    async resolveContext(payload: JWTPayload, accessToken: string, requestId: string): Promise<RequestContext> {
      const userId = asIdString(payload.sub);
      const tenantId = asIdString(payload["tenant_id"]);
      const organizationId = asIdString(payload["organization_id"]);
      if (!userId) throw new AppError(401, "UNAUTHENTICATED", "Token subject is not a valid user id.");
      if (!tenantId || !organizationId) throw new AppError(403, "FORBIDDEN", "No active tenant/organization membership.");
      const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
      return {
        userId: BigInt(userId),
        tenantId: BigInt(tenantId),
        organizationId: BigInt(organizationId),
        roles: strings(payload["roles"]),
        permissions: strings(payload["permissions"]),
        requestId,
        accessToken,
      };
    },
  };
}

export type MockClientOptions = {
  websiteRevision?: number;
  inaccessibleAssetIds?: string[];
  failPages?: boolean;
  pageDelayMs?: number;
};

/** In-process stand-ins for Website/Page/Theme/Media APIs (INTEGRATIONS_MODE=mock). */
export function createMockClients(options: MockClientOptions = {}): Clients {
  let counter = 0;
  const pagesByKey = new Map<string, DraftPageResult[]>();
  // Large on purpose: exercises BIGINT-as-string handling above 2^53.
  const nextId = () => (9007199254741000n + BigInt(++counter)).toString();

  return {
    website: {
      async getWebsite(websiteId) {
        return { id: websiteId, revision: options.websiteRevision ?? MOCK_WEBSITE_REVISION };
      },
    },
    page: {
      async createDraftPages({ idempotencyKey, pages }) {
        if (options.pageDelayMs) await new Promise((r) => setTimeout(r, options.pageDelayMs));
        if (options.failPages) throw new AppError(502, "UPSTREAM_ERROR", "Page API unavailable.");
        const existing = pagesByKey.get(idempotencyKey);
        if (existing) return existing;
        const created = (pages as Array<{ slug: string; title: string }>).map((p) => ({
          pageId: nextId(),
          slug: p.slug,
          title: p.title,
          draftRevisionId: nextId(),
        }));
        pagesByKey.set(idempotencyKey, created);
        return created;
      },
    },
    theme: {
      async applyTheme() {
        /* accepted */
      },
    },
    media: {
      async findInaccessibleAssets(assetIds) {
        const blocked = new Set(options.inaccessibleAssetIds ?? []);
        return assetIds.filter((id) => blocked.has(id));
      },
    },
  };
}
