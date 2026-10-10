import request from "supertest";
import { generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authed, buildTestApp, newIdentity, tokenFor, type TestApp } from "./helpers";

let t: TestApp;
beforeAll(async () => { t = await buildTestApp(); });
afterAll(async () => { await t.close(); });

describe("authentication", () => {
  it("rejects a missing Authorization header", async () => {
    const r = await request(t.app).get("/api/v1/templates");
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe("UNAUTHENTICATED");
    expect(r.body.meta.requestId).toBeTruthy();
  });

  it("rejects malformed schemes and empty tokens", async () => {
    for (const h of ["Basic abc", "Bearer", "Bearer ", "bearer x y", "Token abc"]) {
      const r = await request(t.app).get("/api/v1/templates").set("Authorization", h);
      expect(r.status, h).toBe(401);
    }
  });

  it("never authenticates from the query string or body", async () => {
    const token = await tokenFor(t, newIdentity());
    expect((await request(t.app).get(`/api/v1/templates?access_token=${token}`)).status).toBe(401);
    expect((await request(t.app).get("/api/v1/templates").send({ accessToken: token })).status).toBe(401);
  });

  it("rejects an expired token", async () => {
    const who = newIdentity();
    const token = await t.devIssuer.sign({ sub: who.userId, tenant_id: who.tenantId, organization_id: who.organizationId, permissions: ["template:read"] }, { expiresInSeconds: -60 });
    expect((await request(t.app).get("/api/v1/templates").set("Authorization", `Bearer ${token}`)).status).toBe(401);
  });

  it("rejects wrong issuer and wrong audience", async () => {
    const who = newIdentity();
    const claims = { sub: who.userId, tenant_id: who.tenantId, organization_id: who.organizationId, permissions: ["template:read"] };
    const badIss = await t.devIssuer.sign(claims, { issuer: "https://evil.example" });
    const badAud = await t.devIssuer.sign(claims, { audience: "someone-else" });
    for (const tok of [badIss, badAud]) {
      expect((await request(t.app).get("/api/v1/templates").set("Authorization", `Bearer ${tok}`)).status).toBe(401);
    }
  });

  it("rejects a token signed by an unknown key and an unsigned token", async () => {
    const { privateKey } = await generateKeyPair("RS256");
    const who = newIdentity();
    const forged = await new SignJWT({ sub: who.userId, tenant_id: who.tenantId, organization_id: who.organizationId, permissions: ["template:admin"] })
      .setProtectedHeader({ alg: "RS256", kid: "dev-key-1" })
      .setIssuer(t.config.JWT_ISSUER).setAudience(t.config.JWT_AUDIENCE).setExpirationTime("1h").sign(privateKey);
    expect((await request(t.app).get("/api/v1/templates").set("Authorization", `Bearer ${forged}`)).status).toBe(401);

    const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ sub: who.userId, iss: t.config.JWT_ISSUER, aud: t.config.JWT_AUDIENCE })).toString("base64url");
    expect((await request(t.app).get("/api/v1/templates").set("Authorization", `Bearer ${header}.${payload}.`)).status).toBe(401);
  });

  it("denies a verified token that has no tenant/organization membership", async () => {
    const token = await t.devIssuer.sign({ sub: "55", permissions: ["template:read"] });
    const r = await request(t.app).get("/api/v1/templates").set("Authorization", `Bearer ${token}`);
    expect(r.status).toBe(403);
  });

  it("does not leak identity from the request body", async () => {
    const who = newIdentity();
    const token = await tokenFor(t, who);
    const r = await authed(t, token).post("/api/v1/templates").send({ name: "x", slug: "x-body", tenantId: "999", createdBy: "1" });
    expect(r.status).toBe(400); // strict schema refuses client-chosen ownership fields
  });
});

describe("authorization", () => {
  it("enforces each permission", async () => {
    const who = newIdentity();
    const readOnly = await tokenFor(t, who, ["template:read"]);
    const api = authed(t, readOnly);
    expect((await api.get("/api/v1/templates")).status).toBe(200);
    const denied = await api.post("/api/v1/templates").send({ name: "n", slug: "no-perm" });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("FORBIDDEN");
  });

  it("only platform admins can create platform templates or PUBLIC ones", async () => {
    const who = newIdentity();
    const user = authed(t, await tokenFor(t, who));
    expect((await user.post("/api/v1/templates").send({ name: "p", slug: `p-${Date.now()}`, scope: "PLATFORM" })).status).toBe(403);
    expect((await user.post("/api/v1/templates").send({ name: "p", slug: `q-${Date.now()}`, visibility: "PUBLIC" })).status).toBe(403);

    const admin = authed(t, await tokenFor(t, who, [...(await import("../src/types")).PERMISSIONS]));
    const ok = await admin.post("/api/v1/templates").send({ name: "Platform", slug: `plat-${Date.now()}`, scope: "PLATFORM", visibility: "PUBLIC" });
    expect(ok.status).toBe(201);
    expect(ok.body.data.tenantId).toBeNull();
  });
});

describe("health and errors", () => {
  it("serves /health and /ready without auth", async () => {
    expect((await request(t.app).get("/health")).status).toBe(200);
    expect((await request(t.app).get("/ready")).status).toBe(200);
  });

  it("returns the standard envelope for unknown routes and malformed JSON", async () => {
    const token = await tokenFor(t, newIdentity());
    const nf = await request(t.app).get("/api/v1/nope").set("Authorization", `Bearer ${token}`);
    expect(nf.status).toBe(404);
    expect(nf.body.success).toBe(false);
    const bad = await request(t.app).post("/api/v1/templates").set("Authorization", `Bearer ${token}`).set("Content-Type", "application/json").send("{not json");
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("VALIDATION_ERROR");
  });
});
