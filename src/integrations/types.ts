import type { JWTPayload } from "jose";
import type { RequestContext } from "../types";

export type CallContext = {
  requestId: string;
  tenantId: string;
  organizationId: string;
  userId: string;
  accessToken?: string;
};

export type DraftPageResult = { pageId: string; slug: string; title: string; draftRevisionId: string };

export interface IdentityClient {
  /** Turns a *verified* JWT into a trusted context, checking active tenant/organization membership. */
  resolveContext(payload: JWTPayload, accessToken: string, requestId: string): Promise<RequestContext>;
}

export interface WebsiteClient {
  /** Throws AppError 404/403 when the website is missing or the caller cannot edit it. */
  getWebsite(websiteId: string, call: CallContext): Promise<{ id: string; revision: number }>;
}

export interface PageDocumentClient {
  createDraftPages(
    input: { websiteId: string; idempotencyKey: string; pages: unknown[] },
    call: CallContext,
  ): Promise<DraftPageResult[]>;
}

export interface ThemeClient {
  applyTheme(
    input: { websiteId: string; idempotencyKey: string; theme: Record<string, unknown> },
    call: CallContext,
  ): Promise<void>;
}

export interface MediaClient {
  /** Returns the subset of asset IDs the caller's tenant/organization cannot use. */
  findInaccessibleAssets(assetIds: string[], call: CallContext): Promise<string[]>;
}

export type Clients = {
  website: WebsiteClient;
  page: PageDocumentClient;
  theme: ThemeClient;
  media: MediaClient;
};
