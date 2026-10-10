import { Router } from "express";
import { z } from "zod";
import type { DevIssuer } from "../auth/keys";
import { bigIdSchema } from "../ids";
import { send } from "../http";
import { validate } from "../middleware/validate";
import { PERMISSIONS } from "../types";

const DEFAULT_PERMISSIONS = PERMISSIONS.filter((p) => p !== "template:admin");

const tokenBody = z
  .object({
    userId: bigIdSchema.default("1001"),
    tenantId: bigIdSchema.default("2001"),
    organizationId: bigIdSchema.default("3001"),
    roles: z.array(z.string().max(64)).max(20).default(["editor"]),
    permissions: z.array(z.enum(PERMISSIONS)).default([...DEFAULT_PERMISSIONS]),
    expiresInSeconds: z.number().int().min(60).max(86_400).default(3600),
  })
  .strict();

/**
 * LOCAL DEV ONLY (DEV_AUTH_ENABLED=true, never in production): mints RS256 tokens that the normal
 * authenticate middleware verifies against the local JWKS. Protected routes still only accept Authorization: Bearer.
 */
export function createDevAuthRouter(issuer: DevIssuer): Router {
  const router = Router();

  router.get("/jwks.json", (_req, res) => {
    res.json(issuer.jwks);
  });

  router.post("/token", async (req, res) => {
    const body = validate(tokenBody, req.body);
    const accessToken = await issuer.sign(
      {
        sub: body.userId,
        tenant_id: body.tenantId,
        organization_id: body.organizationId,
        roles: body.roles,
        permissions: body.permissions,
      },
      { expiresInSeconds: body.expiresInSeconds },
    );
    send(res, 200, {
      accessToken,
      tokenType: "Bearer",
      expiresInSeconds: body.expiresInSeconds,
      userId: body.userId,
      tenantId: body.tenantId,
      organizationId: body.organizationId,
      permissions: body.permissions,
    });
  });

  return router;
}
