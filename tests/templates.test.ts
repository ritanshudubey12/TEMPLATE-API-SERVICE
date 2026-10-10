import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authed, buildTestApp, newIdentity, sampleDocument, seedTemplate, tokenFor, uniqueSlug, type TestApp } from "./helpers";

let t: TestApp;
beforeAll(async () => { t = await buildTestApp(); });
afterAll(async () => { await t.close(); });

describe("BIGINT identifiers", () => {
  it("round-trips ids above 2^53 exactly as strings", async () => {
    const who = { userId: "9007199254740993", tenantId: "9007199254740995", organizationId: "9223372036854775807" };
    const api = authed(t, await tokenFor(t, who));
    const created = await api.post("/api/v1/templates").send({ name: "Big", slug: uniqueSlug("big") });
    expect(created.status).toBe(201);
    expect(created.body.data.tenantId).toBe("9007199254740995");
    expect(created.body.data.organizationId).toBe("9223372036854775807");
    expect(created.body.data.createdBy).toBe("9007199254740993");
    expect(typeof created.body.data.id).toBe("string");

    const v = await api.post(`/api/v1/templates/${created.body.data.id}/versions`).send({ document: sampleDocument("9007199254741099") });
    expect(v.body.data.document.pages[0].nodes[0].background.assetId).toBe("9007199254741099");
  });

  it("rejects negative, non-decimal, JSON-number and out-of-range ids", async () => {
    const api = authed(t, await tokenFor(t, newIdentity()));
    for (const id of ["abc", "-1", "1.5", "0", "9223372036854775808", "1e3"]) {
      const r = await api.get(`/api/v1/templates/${id}`);
      expect(r.status, id).toBe(400);
      expect(r.body.error.code, id).toBe("INVALID_ID");
    }
    const num = await api.post("/api/v1/templates/1/publish").send({ versionId: 9007199254740993 });
    expect(num.status).toBe(400);
  });
});

describe("tenant / organization isolation", () => {
  it("hides one tenant's templates, versions and previews from another", async () => {
    const a = authed(t, await tokenFor(t, newIdentity()));
    const b = authed(t, await tokenFor(t, newIdentity()));
    const created = await a.post("/api/v1/templates").send({ name: "Secret", slug: uniqueSlug("sec") });
    const id = created.body.data.id;
    const v = await a.post(`/api/v1/templates/${id}/versions`).send({ document: sampleDocument() });
    const vid = v.body.data.id;

    expect((await b.get(`/api/v1/templates/${id}`)).status).toBe(404);
    expect((await b.get(`/api/v1/templates/${id}/versions`)).status).toBe(404);
    expect((await b.get(`/api/v1/templates/${id}/versions/${vid}`)).status).toBe(404);
    expect((await b.patch(`/api/v1/templates/${id}`).send({ name: "hacked" })).status).toBe(404);
    expect((await b.post(`/api/v1/templates/${id}/publish`).send({})).status).toBe(404);
    expect((await b.post(`/api/v1/templates/${id}/preview-token`).send({})).status).toBe(404);
    const list = await b.get("/api/v1/templates");
    expect(list.body.data.some((x: { id: string }) => x.id === id)).toBe(false);
  });

  it("scopes organization templates to their organization within a tenant", async () => {
    const base = newIdentity();
    const orgA = authed(t, await tokenFor(t, base));
    const orgB = authed(t, await tokenFor(t, { ...base, organizationId: String(Number(base.organizationId) + 1) }));
    const created = await orgA.post("/api/v1/templates").send({ name: "Org only", slug: uniqueSlug("org") });
    expect((await orgB.get(`/api/v1/templates/${created.body.data.id}`)).status).toBe(404);
  });

  it("shows published PUBLIC platform templates read-only to everyone", async () => {
    const adminWho = newIdentity();
    const { PERMISSIONS } = await import("../src/types");
    const admin = authed(t, await tokenFor(t, adminWho, PERMISSIONS));
    const created = await admin.post("/api/v1/templates").send({ name: "Public", slug: uniqueSlug("pub"), scope: "PLATFORM", visibility: "PUBLIC" });
    const id = created.body.data.id;
    const ver = await admin.post(`/api/v1/templates/${id}/versions`).send({ document: sampleDocument() });
    await admin.post(`/api/v1/templates/${id}/publish`).send({ versionId: ver.body.data.id });

    const user = authed(t, await tokenFor(t, newIdentity()));
    expect((await user.get(`/api/v1/templates/${id}`)).status).toBe(200);
    expect((await user.patch(`/api/v1/templates/${id}`).send({ name: "mine now" })).status).toBe(403);
    expect((await user.get(`/api/v1/templates/${id}/versions`)).body.data).toHaveLength(1);
  });
});

describe("template lifecycle", () => {
  it("creates, lists, filters, updates and paginates", async () => {
    const api = authed(t, await tokenFor(t, newIdentity()));
    const slugs = [uniqueSlug("a"), uniqueSlug("b"), uniqueSlug("c")];
    for (const slug of slugs) {
      expect((await api.post("/api/v1/templates").send({ name: `T ${slug}`, slug, category: "travel", tags: ["alpha"] })).status).toBe(201);
    }
    const dup = await api.post("/api/v1/templates").send({ name: "dup", slug: slugs[0] });
    expect(dup.status).toBe(409);

    const page1 = await api.get("/api/v1/templates?limit=2&category=travel&tag=alpha");
    expect(page1.body.data).toHaveLength(2);
    expect(page1.body.meta.nextCursor).toBeTruthy();
    const page2 = await api.get(`/api/v1/templates?limit=2&category=travel&tag=alpha&cursor=${page1.body.meta.nextCursor}`);
    expect(page2.body.data).toHaveLength(1);
    expect((await api.get("/api/v1/templates?q=T%20" + slugs[1])).body.data).toHaveLength(1);
    expect((await api.get("/api/v1/templates?bogus=1")).status).toBe(400);

    const id = page1.body.data[0].id;
    const upd = await api.patch(`/api/v1/templates/${id}`).send({ name: "Renamed", description: null, tags: ["beta"] });
    expect(upd.status).toBe(200);
    expect(upd.body.data.name).toBe("Renamed");
    expect(upd.body.data.tags).toEqual(["beta"]);
    expect((await api.patch(`/api/v1/templates/${id}`).send({})).status).toBe(400);
    expect((await api.post("/api/v1/templates").send({ name: "x", slug: uniqueSlug(), category: "nope" })).status).toBe(400);
  });

  it("keeps published versions immutable and moves the pointer on a new publish", async () => {
    const api = authed(t, await tokenFor(t, newIdentity()));
    const { templateId, versionId } = await seedTemplate(t, (await tokenFor(t, newIdentity())), { publish: false });
    void templateId; void versionId;

    const who = newIdentity();
    const token = await tokenFor(t, who);
    const mine = authed(t, token);
    const seeded = await seedTemplate(t, token, { publish: true });
    const published = await mine.get(`/api/v1/templates/${seeded.templateId}`);
    expect(published.body.data.status).toBe("PUBLISHED");
    expect(published.body.data.currentPublishedVersionId).toBe(seeded.versionId);

    // database trigger refuses any content change to a published version
    await expect(
      t.pool.query("UPDATE template_versions SET document_json = '{}'::jsonb WHERE id = $1::bigint", [seeded.versionId]),
    ).rejects.toThrow(/immutable/);

    expect((await mine.post(`/api/v1/templates/${seeded.templateId}/publish`).send({ versionId: seeded.versionId })).status).toBe(409);

    const v2 = await mine.post(`/api/v1/templates/${seeded.templateId}/versions`).send({ document: sampleDocument("9007199254741100") });
    expect(v2.body.data.versionNumber).toBe(2);
    const pub2 = await mine.post(`/api/v1/templates/${seeded.templateId}/publish`).send({});
    expect(pub2.status).toBe(200);
    expect(pub2.body.data.template.currentPublishedVersionId).toBe(v2.body.data.id);
    const versions = await mine.get(`/api/v1/templates/${seeded.templateId}/versions`);
    expect(versions.body.data.map((v: { versionNumber: number }) => v.versionNumber)).toEqual([2, 1]);
    void api;
  });

  it("archives (idempotently) and blocks further changes", async () => {
    const token = await tokenFor(t, newIdentity());
    const api = authed(t, token);
    const { templateId } = await seedTemplate(t, token, { publish: true });
    expect((await api.post(`/api/v1/templates/${templateId}/archive`).send({ reason: "old" })).body.data.status).toBe("ARCHIVED");
    expect((await api.post(`/api/v1/templates/${templateId}/archive`).send({})).status).toBe(200);
    expect((await api.patch(`/api/v1/templates/${templateId}`).send({ name: "x" })).status).toBe(409);
    expect((await api.post(`/api/v1/templates/${templateId}/versions`).send({ document: sampleDocument() })).status).toBe(409);
    expect((await api.get("/api/v1/templates")).body.data.some((x: { id: string }) => x.id === templateId)).toBe(false);
    expect((await api.get("/api/v1/templates?status=ARCHIVED")).body.data.some((x: { id: string }) => x.id === templateId)).toBe(true);
  });

  it("duplicates idempotently and requires an Idempotency-Key", async () => {
    const token = await tokenFor(t, newIdentity());
    const api = authed(t, token);
    const { templateId } = await seedTemplate(t, token, { publish: true });
    const url = `/api/v1/templates/${templateId}/duplicate`;
    const body = { name: "Copy", slug: uniqueSlug("copy") };

    expect((await api.post(url).send(body)).status).toBe(400);
    const first = await api.post(url).set("Idempotency-Key", "dup-1").send(body);
    expect(first.status).toBe(201);
    expect(first.body.data.template.status).toBe("DRAFT");
    expect(first.body.data.version.versionNumber).toBe(1);
    const again = await api.post(url).set("Idempotency-Key", "dup-1").send(body);
    expect(again.status).toBe(201);
    expect(again.body.data.template.id).toBe(first.body.data.template.id);
    const clash = await api.post(url).set("Idempotency-Key", "dup-1").send({ ...body, name: "Different" });
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("issues a short-lived preview token", async () => {
    const token = await tokenFor(t, newIdentity());
    const api = authed(t, token);
    const { templateId } = await seedTemplate(t, token, { publish: true });
    const r = await api.post(`/api/v1/templates/${templateId}/preview-token`).send({});
    expect(r.status).toBe(201);
    expect(r.body.data.expiresInSeconds).toBe(300);
    expect(r.body.data.token.split(".")).toHaveLength(3);
  });

  it("writes audit rows and outbox events for state changes", async () => {
    const who = newIdentity();
    const token = await tokenFor(t, who);
    const { templateId } = await seedTemplate(t, token, { publish: true });
    const audit = await t.pool.query("SELECT action FROM template_audit_logs WHERE tenant_id = $1::bigint AND resource_id = $2", [who.tenantId, templateId]);
    expect(audit.rows.map((r) => r.action)).toEqual(expect.arrayContaining(["template.create", "template.publish"]));
    const events = await t.pool.query("SELECT 1 FROM outbox_events WHERE event_type = 'template.published' AND payload->>'templateId' = $1", [templateId]);
    expect(events.rowCount).toBe(1);
  });
});

describe("document validation", () => {
  const post = async (document: unknown) => {
    const token = await tokenFor(t, newIdentity());
    const api = authed(t, token);
    const c = await api.post("/api/v1/templates").send({ name: "V", slug: uniqueSlug("val") });
    return api.post(`/api/v1/templates/${c.body.data.id}/versions`).send({ document });
  };
  const withNode = (node: unknown) => ({ schemaVersion: 1, pages: [{ title: "P", slug: "p", nodes: [node] }] });

  it("rejects unsupported schema versions and node types", async () => {
    expect((await post({ ...sampleDocument(), schemaVersion: 99 })).status).toBe(400);
    expect((await post(withNode({ id: "a", type: "iframe-of-doom" }))).status).toBe(400);
  });

  it("rejects script URLs, inline handlers and duplicate ids", async () => {
    expect((await post(withNode({ id: "a", type: "link", props: { href: "javascript:alert(1)" } }))).status).toBe(400);
    expect((await post(withNode({ id: "a", type: "text", props: { onclick: "x()" } }))).status).toBe(400);
    expect((await post(withNode({ id: "a", type: "text", props: { dangerouslySetInnerHTML: "<script>" } }))).status).toBe(400);
    expect((await post({ schemaVersion: 1, pages: [{ title: "P", slug: "p", nodes: [{ id: "a", type: "text" }, { id: "a", type: "text" }] }] })).status).toBe(400);
  });

  it("enforces MediaFlex rules: assets are ids, background video needs a fallback", async () => {
    const video = { type: "video", assetId: "5" };
    expect((await post(withNode({ id: "a", type: "section", background: video }))).status).toBe(400);
    expect((await post(withNode({ id: "a", type: "section", background: { ...video, fallbackAssetId: "6", muted: true, loop: true } }))).status).toBe(201);
    expect((await post(withNode({ id: "a", type: "image", props: { assetId: "https://cdn.example/x.png" } }))).status).toBe(400);
  });

  it("returns 413 when a document exceeds the size limit", async () => {
    const small = await buildTestApp({ env: { TEMPLATE_MAX_DOCUMENT_BYTES: "1500" } });
    try {
      const token = await tokenFor(small, newIdentity());
      const api = authed(small, token);
      const c = await api.post("/api/v1/templates").send({ name: "Big", slug: uniqueSlug("big") });
      const filler = Array.from({ length: 40 }, (_, i) => ({ id: `n${i}`, type: "text", props: { text: "x".repeat(60) } }));
      const r = await api.post(`/api/v1/templates/${c.body.data.id}/versions`).send({ document: { schemaVersion: 1, pages: [{ title: "P", slug: "p", nodes: filler }] } });
      expect(r.status).toBe(413);
      expect(r.body.error.code).toBe("PAYLOAD_TOO_LARGE");
    } finally {
      await small.close();
    }
  });

  it("is safe against SQL injection in search and slugs", async () => {
    const api = authed(t, await tokenFor(t, newIdentity()));
    const r = await api.get("/api/v1/templates?q=" + encodeURIComponent("'; DROP TABLE templates; --"));
    expect(r.status).toBe(200);
    expect((await api.post("/api/v1/templates").send({ name: "x", slug: "x'; DROP TABLE templates;--" })).status).toBe(400);
    expect((await t.pool.query("SELECT count(*) FROM templates")).rows[0].count).toBeDefined();
  });
});
