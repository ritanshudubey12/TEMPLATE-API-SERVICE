import "dotenv/config";
import { randomInt } from "node:crypto";
import request from "supertest";
import { createApp } from "../src/app";
import { createDevIssuer, createKeyResolver, type DevIssuer } from "../src/auth/keys";
import { loadConfig, type Config } from "../src/config/env";
import { createPool } from "../src/db/pool";
import { createMockClients, createMockIdentityClient, type MockClientOptions } from "../src/integrations/mock-clients";
import { createLogger } from "../src/observability/logger";
import { PERMISSIONS } from "../src/types";

export const ALL_BUT_ADMIN = PERMISSIONS.filter((p) => p !== "template:admin");

export async function buildTestApp(opts: { env?: Record<string, string>; mock?: MockClientOptions } = {}) {
  const config: Config = loadConfig({
    ...process.env,
    NODE_ENV: "test",
    DEV_AUTH_ENABLED: "true",
    LOG_LEVEL: "silent",
    RATE_LIMIT_MAX_REQUESTS: "100000",
    ...opts.env,
  });
  const logger = createLogger("silent");
  const pool = createPool(config, logger);
  const devIssuer: DevIssuer = await createDevIssuer(config);
  const { app, applyService } = createApp({
    config, pool, logger, devIssuer,
    keyResolver: createKeyResolver(config, devIssuer),
    identity: createMockIdentityClient(),
    clients: createMockClients(opts.mock),
  });
  return { app, pool, config, devIssuer, applyService, close: () => pool.end() };
}

export type TestApp = Awaited<ReturnType<typeof buildTestApp>>;

/** Fresh, random tenant/org/user per call so test runs never collide with each other or with Postman data. */
export function newIdentity() {
  const n = () => String(randomInt(1_000_000, 900_000_000));
  return { userId: n(), tenantId: n(), organizationId: n() };
}

export async function tokenFor(
  t: TestApp,
  who: { userId: string; tenantId: string; organizationId: string },
  permissions: readonly string[] = ALL_BUT_ADMIN,
) {
  return t.devIssuer.sign({
    sub: who.userId,
    tenant_id: who.tenantId,
    organization_id: who.organizationId,
    roles: ["tester"],
    permissions: [...permissions],
  });
}

export const authed = (t: TestApp, token: string) => ({
  get: (url: string) => request(t.app).get(url).set("Authorization", `Bearer ${token}`),
  post: (url: string) => request(t.app).post(url).set("Authorization", `Bearer ${token}`),
  patch: (url: string) => request(t.app).patch(url).set("Authorization", `Bearer ${token}`),
});

export const uniqueSlug = (prefix = "tpl") => `${prefix}-${Date.now()}-${randomInt(1000, 9999)}`;

export const sampleDocument = (assetId = "9007199254741099") => ({
  schemaVersion: 1,
  pages: [
    {
      title: "Home",
      slug: "home",
      nodes: [
        {
          id: "hero",
          type: "section",
          background: { type: "image", assetId, fit: "cover", focalPoint: { x: 0.5, y: 0.45 }, overlay: { color: "#102030", opacity: 0.2 } },
          children: [{ id: "hero-title", type: "heading", props: { text: "Discover the world" } }],
        },
      ],
    },
    { title: "About", slug: "about", nodes: [{ id: "t", type: "text", props: { text: "About us" } }] },
  ],
});

/** Creates a template (and optionally a published version) and returns the ids. */
export async function seedTemplate(t: TestApp, token: string, opts: { publish?: boolean; assetId?: string } = {}) {
  const api = authed(t, token);
  const created = await api.post("/api/v1/templates").send({ name: "Seed", slug: uniqueSlug(), category: "business" });
  if (created.status !== 201) throw new Error(`seed create failed: ${created.status} ${JSON.stringify(created.body)}`);
  const templateId: string = created.body.data.id;
  const v = await api.post(`/api/v1/templates/${templateId}/versions`).send({ document: sampleDocument(opts.assetId), theme: { colors: { primary: "#000000" } } });
  if (v.status !== 201) throw new Error(`seed version failed: ${v.status} ${JSON.stringify(v.body)}`);
  const versionId: string = v.body.data.id;
  if (opts.publish) {
    const p = await api.post(`/api/v1/templates/${templateId}/publish`).send({ versionId });
    if (p.status !== 200) throw new Error(`seed publish failed: ${p.status}`);
  }
  return { templateId, versionId };
}

export async function waitForJob(t: TestApp, token: string, jobId: string, want = "SUCCEEDED") {
  for (let i = 0; i < 50; i++) {
    const r = await authed(t, token).get(`/api/v1/template-apply-jobs/${jobId}`);
    if (r.body?.data?.status === want || r.body?.data?.status === "FAILED") return r;
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error("job did not finish");
}
