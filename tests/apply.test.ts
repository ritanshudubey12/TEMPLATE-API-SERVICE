import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authed, buildTestApp, newIdentity, seedTemplate, tokenFor, waitForJob, type TestApp } from "./helpers";

let t: TestApp;
beforeAll(async () => { t = await buildTestApp({ mock: { inaccessibleAssetIds: ["666"] } }); });
afterAll(async () => { await t.close(); });

const body = (versionId: string, extra: Record<string, unknown> = {}) => ({
  websiteId: "67890", versionId, mode: "CREATE_PAGES", includeTheme: true, expectedWebsiteRevision: 7, ...extra,
});

describe("apply template", () => {
  it("creates draft pages asynchronously and never publishes", async () => {
    const token = await tokenFor(t, newIdentity());
    const api = authed(t, token);
    const { templateId, versionId } = await seedTemplate(t, token, { publish: true });

    const res = await api.post(`/api/v1/templates/${templateId}/apply`).set("Idempotency-Key", "apply-1").send(body(versionId));
    expect(res.status).toBe(202);
    expect(res.headers.location).toBe(`/api/v1/template-apply-jobs/${res.body.data.jobId}`);

    const job = await waitForJob(t, token, res.body.data.jobId);
    expect(job.status).toBe(200);
    expect(job.body.data.status).toBe("SUCCEEDED");
    expect(job.body.data.result.published).toBe(false);
    expect(job.body.data.result.themeApplied).toBe(true);
    expect(job.body.data.result.pages).toHaveLength(2);
    // BIGINT ids from the page service survive as strings
    expect(job.body.data.result.pages[0].pageId).toMatch(/^9007199254741\d{3}$/);

    const events = await t.pool.query("SELECT event_type FROM outbox_events WHERE payload->>'jobId' = $1", [res.body.data.jobId]);
    expect(events.rows.map((r) => r.event_type)).toEqual(expect.arrayContaining(["template.apply.queued", "template.applied"]));
  });

  it("is idempotent: same key+request returns the same job, different request conflicts", async () => {
    const token = await tokenFor(t, newIdentity());
    const api = authed(t, token);
    const { templateId, versionId } = await seedTemplate(t, token, { publish: true });
    const url = `/api/v1/templates/${templateId}/apply`;

    const first = await api.post(url).set("Idempotency-Key", "same").send(body(versionId));
    const second = await api.post(url).set("Idempotency-Key", "same").send(body(versionId));
    expect(second.status).toBe(202);
    expect(second.body.data.jobId).toBe(first.body.data.jobId);
    const count = await t.pool.query("SELECT count(*) FROM template_apply_jobs WHERE id = $1::bigint", [first.body.data.jobId]);
    expect(count.rows[0].count).toBe("1");

    const clash = await api.post(url).set("Idempotency-Key", "same").send(body(versionId, { websiteId: "11111" }));
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe("IDEMPOTENCY_CONFLICT");

    const parallel = await Promise.all([1, 2, 3].map(() => api.post(url).set("Idempotency-Key", "race").send(body(versionId))));
    expect(new Set(parallel.map((r) => r.body.data.jobId)).size).toBe(1);
  });

  it("requires an Idempotency-Key and validates input", async () => {
    const token = await tokenFor(t, newIdentity());
    const api = authed(t, token);
    const { templateId, versionId } = await seedTemplate(t, token, { publish: true });
    const url = `/api/v1/templates/${templateId}/apply`;
    expect((await api.post(url).send(body(versionId))).status).toBe(400);
    expect((await api.post(url).set("Idempotency-Key", "k").send({ websiteId: 67890 })).status).toBe(400);
    expect((await api.post(url).set("Idempotency-Key", "k").send({ ...body(versionId), tenantId: "1" })).status).toBe(400);
    expect((await api.post(url).set("Idempotency-Key", "k").send({ ...body(versionId), mode: "REPLACE_ALL" })).status).toBe(400);
  });

  it("returns 409 REVISION_CONFLICT for a stale website revision", async () => {
    const token = await tokenFor(t, newIdentity());
    const { templateId, versionId } = await seedTemplate(t, token, { publish: true });
    const r = await authed(t, token).post(`/api/v1/templates/${templateId}/apply`).set("Idempotency-Key", "stale").send(body(versionId, { expectedWebsiteRevision: 6 }));
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("REVISION_CONFLICT");
  });

  it("refuses unpublished, archived and unknown versions", async () => {
    const token = await tokenFor(t, newIdentity());
    const api = authed(t, token);
    const draft = await seedTemplate(t, token, { publish: false });
    const noPublished = await api.post(`/api/v1/templates/${draft.templateId}/apply`).set("Idempotency-Key", "d1").send({ websiteId: "1" });
    expect(noPublished.status).toBe(409);
    const draftVersion = await api.post(`/api/v1/templates/${draft.templateId}/apply`).set("Idempotency-Key", "d2").send(body(draft.versionId));
    expect(draftVersion.status).toBe(404);

    const pub = await seedTemplate(t, token, { publish: true });
    await api.post(`/api/v1/templates/${pub.templateId}/archive`).send({});
    expect((await api.post(`/api/v1/templates/${pub.templateId}/apply`).set("Idempotency-Key", "d3").send(body(pub.versionId))).status).toBe(409);
  });

  it("rejects media assets the organization cannot access", async () => {
    const token = await tokenFor(t, newIdentity());
    const { templateId, versionId } = await seedTemplate(t, token, { publish: true, assetId: "666" });
    const r = await authed(t, token).post(`/api/v1/templates/${templateId}/apply`).set("Idempotency-Key", "media").send(body(versionId));
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("MEDIA_ASSET_INACCESSIBLE");
    expect(r.body.error.details.assetIds).toEqual(["666"]);
  });

  it("requires template:apply and isolates jobs per tenant", async () => {
    const owner = newIdentity();
    const token = await tokenFor(t, owner);
    const { templateId, versionId } = await seedTemplate(t, token, { publish: true });
    const readOnly = authed(t, await tokenFor(t, owner, ["template:read"]));
    expect((await readOnly.post(`/api/v1/templates/${templateId}/apply`).set("Idempotency-Key", "p").send(body(versionId))).status).toBe(403);

    const res = await authed(t, token).post(`/api/v1/templates/${templateId}/apply`).set("Idempotency-Key", "iso").send(body(versionId));
    const other = authed(t, await tokenFor(t, newIdentity()));
    expect((await other.get(`/api/v1/template-apply-jobs/${res.body.data.jobId}`)).status).toBe(404);
    const denied = await t.pool.query("SELECT 1 FROM template_audit_logs WHERE action = 'security.denied' AND tenant_id = $1::bigint", [owner.tenantId]);
    expect(denied.rowCount).toBeGreaterThan(0);
  });

  it("marks the job FAILED when the page service is down, and recovers nothing silently", async () => {
    const failing = await buildTestApp({ mock: { failPages: true } });
    try {
      const token = await tokenFor(failing, newIdentity());
      const { templateId, versionId } = await seedTemplate(failing, token, { publish: true });
      const res = await authed(failing, token).post(`/api/v1/templates/${templateId}/apply`).set("Idempotency-Key", "fail").send(body(versionId));
      expect(res.status).toBe(202);
      const job = await waitForJob(failing, token, res.body.data.jobId);
      expect(job.body.data.status).toBe("FAILED");
      expect(job.body.data.errorCode).toBe("UPSTREAM_ERROR");
    } finally {
      await failing.close();
    }
  });

  it("times out slow jobs into a terminal FAILED state", async () => {
    const slow = await buildTestApp({ env: { TEMPLATE_APPLY_JOB_TIMEOUT_MS: "100" }, mock: { pageDelayMs: 1000 } });
    try {
      const token = await tokenFor(slow, newIdentity());
      const { templateId, versionId } = await seedTemplate(slow, token, { publish: true });
      const res = await authed(slow, token).post(`/api/v1/templates/${templateId}/apply`).set("Idempotency-Key", "slow").send(body(versionId));
      const job = await waitForJob(slow, token, res.body.data.jobId);
      expect(job.body.data.errorCode).toBe("APPLY_TIMEOUT");
    } finally {
      await slow.close();
    }
  });
});
