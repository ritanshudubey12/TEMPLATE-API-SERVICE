import { createHash } from "node:crypto";
import { z } from "zod";
import { bigIdSchema } from "../../ids";
import { documentSchema, SLUG_RE, themeSchema } from "./document.schema";

const slug = z.string().min(2).max(80).regex(SLUG_RE, "must be lowercase letters, digits and hyphens");
const tag = z.string().max(50).regex(SLUG_RE, "must be lowercase letters, digits and hyphens");
const scope = z.enum(["PLATFORM", "TENANT", "ORGANIZATION"]);
const visibility = z.enum(["PRIVATE", "TENANT", "ORGANIZATION", "PUBLIC"]);
const status = z.enum(["DRAFT", "PUBLISHED", "ARCHIVED"]);

// .strict() everywhere: clients cannot smuggle userId/tenantId/organizationId/createdBy/roles into a body.
export const createTemplateBody = z
  .object({
    name: z.string().trim().min(1).max(200),
    slug,
    description: z.string().max(2000).optional(),
    category: slug.default("general"),
    tags: z.array(tag).max(20).default([]),
    scope: scope.default("ORGANIZATION"),
    visibility: visibility.default("PRIVATE"),
  })
  .strict();

export const updateTemplateBody = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().max(2000).nullable(),
    category: slug,
    tags: z.array(tag).max(20),
    visibility,
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "at least one field is required" });

export const listQuery = z
  .object({
    q: z.string().trim().min(1).max(100).optional(),
    category: slug.optional(),
    tag: tag.optional(),
    status: status.optional(),
    scope: scope.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: bigIdSchema.optional(),
  })
  .strict();

export const createVersionBody = z
  .object({
    document: documentSchema,
    theme: themeSchema.default({}),
    requiredFeatures: z.array(z.string().min(1).max(64)).max(50).default([]),
    previewAssetId: bigIdSchema.optional(),
  })
  .strict();

export const publishBody = z.object({ versionId: bigIdSchema.optional() }).strict();
export const archiveBody = z.object({ reason: z.string().max(500).optional() }).strict();
export const previewBody = z.object({ versionId: bigIdSchema.optional() }).strict();

export const duplicateBody = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    slug: slug.optional(),
    scope: scope.optional(),
    visibility: visibility.optional(),
    versionId: bigIdSchema.optional(),
  })
  .strict();

export const applyBody = z
  .object({
    websiteId: bigIdSchema,
    versionId: bigIdSchema.optional(),
    mode: z.literal("CREATE_PAGES").default("CREATE_PAGES"),
    includeTheme: z.boolean().default(false),
    mediaPolicy: z.literal("REUSE_ACCESSIBLE_ASSETS").default("REUSE_ACCESSIBLE_ASSETS"),
    expectedWebsiteRevision: z.number().int().min(0).optional(),
  })
  .strict();

export const idempotencyKeySchema = z
  .string({ required_error: "Idempotency-Key header is required" })
  .regex(/^[A-Za-z0-9._:-]{1,255}$/, "must be 1-255 chars of letters, digits, . _ : -");

export type CreateTemplateInput = z.output<typeof createTemplateBody>;
export type UpdateTemplateInput = z.output<typeof updateTemplateBody>;
export type ListQuery = z.output<typeof listQuery>;
export type CreateVersionInput = z.output<typeof createVersionBody>;
export type DuplicateInput = z.output<typeof duplicateBody>;
export type ApplyInput = z.output<typeof applyBody>;

/** Deterministic JSON (sorted keys) so equal payloads always hash/checksum identically. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export const sha256 = (value: unknown) => createHash("sha256").update(stableStringify(value)).digest("hex");
