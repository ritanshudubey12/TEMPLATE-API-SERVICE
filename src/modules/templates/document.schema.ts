import { z } from "zod";
import { bigIdSchema } from "../../ids";

export const SUPPORTED_SCHEMA_VERSIONS = [1] as const;
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const NODE_TYPES = [
  "section", "container", "columns", "heading", "text", "image", "video", "button", "link",
  "list", "gallery", "form", "divider", "spacer",
] as const;

export type DocNode = {
  id: string;
  type: (typeof NODE_TYPES)[number];
  props?: Record<string, unknown>;
  background?: Background;
  children?: DocNode[];
};

const hex = z.string().regex(/^#[0-9a-fA-F]{3,8}$/, "must be a hex color");

// MediaFlex placement: asset IDs + fit/crop/focal point/overlay. Never URLs or binaries.
const backgroundSchema = z
  .object({
    type: z.enum(["image", "video", "color", "gradient"]),
    assetId: bigIdSchema.optional(),
    fallbackAssetId: bigIdSchema.optional(),
    color: z.string().max(64).optional(),
    fit: z.enum(["cover", "contain", "fill", "none"]).optional(),
    focalPoint: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).strict().optional(),
    overlay: z.object({ color: hex, opacity: z.number().min(0).max(1) }).strict().optional(),
    autoplay: z.boolean().optional(),
    loop: z.boolean().optional(),
    muted: z.boolean().optional(),
  })
  .strict()
  .superRefine((b, ctx) => {
    if ((b.type === "image" || b.type === "video") && !b.assetId) {
      ctx.addIssue({ code: "custom", path: ["assetId"], message: `assetId is required for a ${b.type} background` });
    }
    if (b.type === "video" && !b.fallbackAssetId) {
      ctx.addIssue({ code: "custom", path: ["fallbackAssetId"], message: "a video background requires a fallback image (fallbackAssetId)" });
    }
  });

type Background = z.infer<typeof backgroundSchema>;

const nodeSchema: z.ZodType<DocNode> = z.lazy(() =>
  z
    .object({
      id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "must be 1-64 chars of letters, digits, _ or -"),
      type: z.enum(NODE_TYPES),
      props: z.record(z.string(), z.unknown()).optional(),
      background: backgroundSchema.optional(),
      children: z.array(nodeSchema).max(500).optional(),
    })
    .strict()
    .superRefine((n, ctx) => {
      const asset = n.props?.["assetId"];
      if (asset !== undefined && !bigIdSchema.safeParse(asset).success) {
        ctx.addIssue({ code: "custom", path: ["props", "assetId"], message: "assetId must be a decimal BIGINT string" });
      }
    }),
);

const pageSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    slug: z.string().max(80).regex(SLUG_RE, "must be lowercase letters, digits and hyphens"),
    nodes: z.array(nodeSchema).max(500),
  })
  .strict();

const URL_KEYS = new Set(["href", "src", "url", "action", "poster"]);
const ALLOWED_SCHEMES = new Set(["http", "https", "mailto", "tel"]);
const FORBIDDEN_KEYS = new Set(["dangerouslySetInnerHTML", "__proto__", "constructor", "prototype", "script"]);
const MAX_DEPTH = 20;
const MAX_NODES = 5000;

type Issue = { path: (string | number)[]; message: string };

/** Structural safety scan over props/theme/etc: no inline handlers, no script-ish URL schemes. */
export function scanForUnsafeContent(value: unknown, path: (string | number)[] = [], key = ""): Issue[] {
  const issues: Issue[] = [];
  if (typeof value === "string") {
    const scheme = /^\s*([a-z][a-z0-9+.-]*):/i.exec(value)?.[1]?.toLowerCase();
    if (scheme && !ALLOWED_SCHEMES.has(scheme) && (URL_KEYS.has(key) || ["javascript", "vbscript", "data"].includes(scheme))) {
      issues.push({ path, message: `URL scheme "${scheme}:" is not allowed` });
    }
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => issues.push(...scanForUnsafeContent(v, [...path, i], key)));
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(k) || /^on[A-Za-z]/.test(k)) {
        issues.push({ path: [...path, k], message: `property "${k}" is not allowed` });
        continue;
      }
      issues.push(...scanForUnsafeContent(v, [...path, k], k));
    }
  }
  return issues;
}

export const documentSchema = z
  .object({
    schemaVersion: z.number().int().refine((v) => (SUPPORTED_SCHEMA_VERSIONS as readonly number[]).includes(v), {
      message: `unsupported schemaVersion; supported: ${SUPPORTED_SCHEMA_VERSIONS.join(", ")}`,
    }),
    pages: z.array(pageSchema).min(1).max(100),
  })
  .strict()
  .superRefine((doc, ctx) => {
    const slugs = new Set<string>();
    let total = 0;
    doc.pages.forEach((page, pi) => {
      if (slugs.has(page.slug)) ctx.addIssue({ code: "custom", path: ["pages", pi, "slug"], message: "duplicate page slug" });
      slugs.add(page.slug);
      const ids = new Set<string>();
      const walk = (nodes: DocNode[], depth: number, p: (string | number)[]) =>
        nodes.forEach((n, ni) => {
          total += 1;
          const np = [...p, ni];
          if (depth > MAX_DEPTH) return void ctx.addIssue({ code: "custom", path: np, message: `nesting deeper than ${MAX_DEPTH}` });
          if (ids.has(n.id)) ctx.addIssue({ code: "custom", path: [...np, "id"], message: "duplicate node id within page" });
          ids.add(n.id);
          if (n.children) walk(n.children, depth + 1, [...np, "children"]);
        });
      walk(page.nodes, 1, ["pages", pi, "nodes"]);
    });
    if (total > MAX_NODES) ctx.addIssue({ code: "custom", path: ["pages"], message: `more than ${MAX_NODES} nodes` });
    for (const i of scanForUnsafeContent(doc)) ctx.addIssue({ code: "custom", path: i.path, message: i.message });
  });

export type TemplateDocument = z.infer<typeof documentSchema>;

export const themeSchema = z
  .record(z.string(), z.unknown())
  .superRefine((theme, ctx) => {
    for (const i of scanForUnsafeContent(theme)) ctx.addIssue({ code: "custom", path: i.path, message: i.message });
  });

/** Every MediaFlex asset reference in a document (background, fallback and foreground assets). */
export function collectAssetIds(doc: TemplateDocument): string[] {
  const found = new Set<string>();
  const walk = (nodes: DocNode[]) => {
    for (const n of nodes) {
      const a = n.props?.["assetId"];
      if (typeof a === "string") found.add(a);
      if (n.background?.assetId) found.add(n.background.assetId);
      if (n.background?.fallbackAssetId) found.add(n.background.fallbackAssetId);
      if (n.children) walk(n.children);
    }
  };
  doc.pages.forEach((p) => walk(p.nodes));
  return [...found];
}
