import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const spec = parse(fs.readFileSync(path.resolve(__dirname, "../openapi/openapi.yaml"), "utf8"));
const collection = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../postman/Template-API.postman_collection.json"), "utf8"));

describe("OpenAPI contract", () => {
  it("is 3.1 with bearer security and every catalogue endpoint", () => {
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.components.securitySchemes.BearerAuth.scheme).toBe("bearer");
    const expected = [
      "get /api/v1/templates", "post /api/v1/templates", "get /api/v1/templates/{templateId}", "patch /api/v1/templates/{templateId}",
      "get /api/v1/templates/{templateId}/versions", "post /api/v1/templates/{templateId}/versions",
      "get /api/v1/templates/{templateId}/versions/{versionId}", "post /api/v1/templates/{templateId}/publish",
      "post /api/v1/templates/{templateId}/archive", "post /api/v1/templates/{templateId}/duplicate",
      "post /api/v1/templates/{templateId}/apply", "get /api/v1/template-apply-jobs/{jobId}",
      "post /api/v1/templates/{templateId}/preview-token", "get /health", "get /ready",
    ];
    for (const e of expected) {
      const [method, p] = e.split(" ") as [string, string];
      expect(spec.paths[p]?.[method], e).toBeTruthy();
    }
  });

  it("resolves every $ref", () => {
    const refs = [...JSON.stringify(spec).matchAll(/"\$ref":"#\/([^"]+)"/g)].map((m) => m[1]!.split("/"));
    for (const ref of refs) {
      let node: unknown = spec;
      for (const part of ref) node = (node as Record<string, unknown>)?.[part];
      expect(node, ref.join("/")).toBeTruthy();
    }
  });

  it("models ids as BIGINT strings and never accepts a token in a body", () => {
    expect(spec.components.schemas.BigIntId.type).toBe("string");
    expect(spec.components.schemas.BigIntId.pattern).toBe("^[0-9]+$");
    expect(JSON.stringify(spec.components.schemas)).not.toMatch(/accessToken|authorization/i);
  });

  it("is covered by the Postman collection (every method+path appears)", () => {
    const seen = new Set<string>();
    const walk = (items: any[]) => items.forEach((i) => (i.item ? walk(i.item) : seen.add(`${i.request.method} /${i.request.url.path.join("/")}`)));
    walk(collection.item);
    const norm = (s: string) => s.replace(/\{\{[^}]+\}\}/g, "{id}");
    const covered = new Set([...seen].map(norm));
    for (const [p, ops] of Object.entries<Record<string, unknown>>(spec.paths)) {
      if (p === "/dev/token") continue;
      for (const method of Object.keys(ops).filter((k) => ["get", "post", "patch"].includes(k))) {
        expect(covered.has(norm(`${method.toUpperCase()} ${p}`.replace(/\{[^}]+\}/g, "{id}"))), `${method} ${p}`).toBe(true);
      }
    }
  });
});
