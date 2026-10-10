import type { RequestHandler } from "express";
import { jwtVerify, type JWTVerifyGetKey } from "jose";
import { JWT_ALGORITHM } from "../auth/keys";
import type { Config } from "../config/env";
import { AppError } from "../errors";
import type { IdentityClient } from "../integrations/types";

const BEARER = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/;
const unauthenticated = (message: string) => new AppError(401, "UNAUTHENTICATED", message);

/**
 * Reads the access token ONLY from the Authorization header, verifies signature/issuer/audience/expiry,
 * then resolves the trusted tenant/organization context. Body, query and path never carry identity.
 */
export function authenticate(config: Config, getKey: JWTVerifyGetKey, identity: IdentityClient): RequestHandler {
  return async (req, res, next) => {
    const header = req.header("authorization");
    const match = header ? BEARER.exec(header) : null;
    if (!match?.[1]) throw unauthenticated("A valid Bearer token is required.");
    const token = match[1];

    let payload;
    try {
      ({ payload } = await jwtVerify(token, getKey, {
        issuer: config.JWT_ISSUER,
        audience: config.JWT_AUDIENCE,
        algorithms: [JWT_ALGORITHM],
        requiredClaims: ["sub", "exp"],
      }));
    } catch {
      throw unauthenticated("Invalid or expired access token.");
    }

    res.locals.ctx = await identity.resolveContext(payload, token, res.locals.requestId);
    next();
  };
}
