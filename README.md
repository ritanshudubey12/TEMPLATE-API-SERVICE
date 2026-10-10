# Template API Microservice

Reusable full-site / page templates for the Website Builder platform.
Node.js + TypeScript + Express, PostgreSQL through the `pg` driver with parameterized SQL and plain SQL migrations. **No Prisma, no ORM.**

## Run it (Docker)

```bash
cp .env.example .env        # already present for local use
docker compose up --build -d
curl http://localhost:4018/health    # {"status":"ok"}
curl http://localhost:4018/ready     # {"status":"ready"}
```

`docker compose up` starts `db` (Postgres 16), runs the one-shot `migrate` service (applies `migrations/*.sql`, then exits), then starts `api` on port **4018**.
Reset everything including data: `docker compose down -v`.

## Run it on the host

```bash
docker compose up -d db
npm install
npm run migrate
npm run dev                  # tsx watch
```

## Test it with Postman

Import both files from [postman/](postman/):

- `Template-API.postman_collection.json`
- `Template-API.local.postman_environment.json` (select it; `baseUrl = http://localhost:4018`)

Run the collection top to bottom (Collection Runner). Folder **00 Setup** fetches a local dev token into `{{accessToken}}`; the collection then sends it as `Authorization: Bearer`. Expected results: GET 200, POST 201 (create, version, duplicate, preview token) / 200 (publish, archive) / 202 (apply), PATCH 200. Folder **07** contains four requests that are *supposed* to return 401/400/404/409. Each run creates fresh slugs and idempotency keys, so it can be repeated.

CLI: `npm run postman` (uses Newman via npx). Last result: 23 requests, 50 assertions, 0 failed.

## Automated tests

```bash
docker compose up -d db && npm run migrate    # tests use the real database
npm test            # 45 tests: auth, RBAC, tenant isolation, BIGINT, lifecycle, apply/idempotency, validation, OpenAPI
npm run typecheck
```

## Endpoints (`/api/v1`, all need `Authorization: Bearer <token>`)

| Method | Path | Permission | Success |
|---|---|---|---|
| GET | `/templates` | template:read | 200 |
| POST | `/templates` | template:create | 201 |
| GET | `/templates/{id}` | template:read | 200 |
| PATCH | `/templates/{id}` | template:update | 200 |
| GET | `/templates/{id}/versions` | template:read | 200 |
| POST | `/templates/{id}/versions` | template:update | 201 |
| GET | `/templates/{id}/versions/{versionId}` | template:read | 200 |
| POST | `/templates/{id}/publish` | template:publish | 200 |
| POST | `/templates/{id}/archive` | template:archive | 200 |
| POST | `/templates/{id}/duplicate` (`Idempotency-Key`) | template:create | 201 |
| POST | `/templates/{id}/preview-token` | template:read | 201 |
| POST | `/templates/{id}/apply` (`Idempotency-Key`) | template:apply | 202 |
| GET | `/template-apply-jobs/{jobId}` | template:read | 200 |
| GET | `/health`, `/ready` | none | 200 |

Full contract: [openapi/openapi.yaml](openapi/openapi.yaml) (OpenAPI 3.1).
Errors use `{ "success": false, "error": { "code", "message", "details" }, "meta": { "requestId" } }`.

## How the key rules are implemented

- **Auth:** the token is read only from the `Authorization` header and verified with `jose` (RS256 signature, issuer, audience, expiry, `sub`/`exp` required). Body/query tokens are ignored (401).
- **Identity:** `userId`, `tenantId`, `organizationId`, roles and permissions come only from the verified token via the Identity client. Bodies are `.strict()`, so sending `tenantId`/`createdBy` is a 400.
- **Isolation:** every template query carries the caller's tenant/org in SQL; resources outside that scope return 404, visible-but-read-only ones return 403.
- **BIGINT:** DB ids are `BIGINT`, always selected as `::text`, accepted/returned as decimal strings; JSON-number ids are rejected. Tests round-trip ids above 2^53 (up to 9223372036854775807).
- **Immutability:** published versions can't change content (enforced by a database trigger as well as the service). Publishing moves `current_published_version_id`.
- **Apply:** returns 202 and a job. It creates **draft pages only** and never publishes. Idempotent on `Idempotency-Key` + request hash (replay returns the same job; a different request is 409 `IDEMPOTENCY_CONFLICT`); stale `expectedWebsiteRevision` is 409 `REVISION_CONFLICT`; jobs time out into `FAILED`; incomplete jobs are re-run on startup.
- **Audit/outbox:** written in the same transaction as the state change; denied actions are audited. A poller delivers outbox events (log, or `OUTBOX_WEBHOOK_URL`).

## Local-only pieces you must replace for production

1. **Dev tokens.** There is no Identity Provider in this repo. With `DEV_AUTH_ENABLED=true` the service exposes `POST /dev/token` and `/dev/jwks.json` and signs RS256 tokens with an in-memory key. In production set `JWT_JWKS_URL`, `JWT_ISSUER`, `JWT_AUDIENCE` and `DEV_AUTH_ENABLED=false` (startup refuses dev auth when `NODE_ENV=production`).
2. **Mock integrations.** `INTEGRATIONS_MODE=mock` uses in-process stand-ins for Identity, Website, Page/Document, Theme and Media (every website reports revision 7). `INTEGRATIONS_MODE=http` uses [src/integrations/http-clients.ts](src/integrations/http-clients.ts), whose downstream paths/payloads are **assumptions** and have not been run against real services. Adjust them to the real APIs.
3. Set `PREVIEW_TOKEN_SECRET` (32+ chars), real DB credentials, TLS in front, and a restricted `CORS_ALLOWED_ORIGINS`.

## Deliberate choices / deviations from the report

- Tags link to the **template** (`template_tag_links(template_id, tag_id)`), not to a version, so tags are catalog metadata.
- `GET /templates` requires `template:read` for every caller (simpler than anonymous-public browsing).
- Publishing API is not called: apply never publishes, so there is no client for it.
- Migrations are plain SQL run by `src/db/migrate.ts` as a deploy step (never at app startup). `migrations/down/` holds a local-dev rollback only.
- Not included: Redis/BullMQ (apply uses an in-process job runner backed by the `template_apply_jobs` table), load testing, and a real-IdP integration test.
