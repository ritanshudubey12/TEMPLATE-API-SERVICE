import {
  createLocalJWKSet,
  createRemoteJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWK,
  type JWTPayload,
  type JWTVerifyGetKey,
  type KeyLike,
} from "jose";
import type { Config } from "../config/env";

export const JWT_ALGORITHM = "RS256";

export type SignOptions = { issuer?: string; audience?: string; expiresInSeconds?: number; notBefore?: number };

/** LOCAL DEV ONLY: an in-memory RS256 key pair that stands in for the Identity Provider. */
export type DevIssuer = {
  jwks: { keys: JWK[] };
  sign(claims: JWTPayload, opts?: SignOptions): Promise<string>;
};

export async function createDevIssuer(config: Pick<Config, "JWT_ISSUER" | "JWT_AUDIENCE">): Promise<DevIssuer> {
  const { publicKey, privateKey } = await generateKeyPair(JWT_ALGORITHM);
  const jwk = await exportJWK(publicKey);
  const kid = "dev-key-1";
  const jwks = { keys: [{ ...jwk, kid, alg: JWT_ALGORITHM, use: "sig" }] };

  return {
    jwks,
    async sign(claims, opts = {}) {
      const now = Math.floor(Date.now() / 1000);
      const jwt = new SignJWT(claims)
        .setProtectedHeader({ alg: JWT_ALGORITHM, kid })
        .setIssuer(opts.issuer ?? config.JWT_ISSUER)
        .setAudience(opts.audience ?? config.JWT_AUDIENCE)
        .setIssuedAt(now)
        .setExpirationTime(now + (opts.expiresInSeconds ?? 3600));
      if (opts.notBefore !== undefined) jwt.setNotBefore(opts.notBefore);
      return jwt.sign(privateKey as KeyLike);
    },
  };
}

/** Real JWKS when configured, otherwise the local dev issuer's key set. */
export function createKeyResolver(config: Config, devIssuer?: DevIssuer): JWTVerifyGetKey {
  if (config.JWT_JWKS_URL) return createRemoteJWKSet(new URL(config.JWT_JWKS_URL), { cooldownDuration: 30_000, timeoutDuration: 5_000 });
  if (devIssuer) return createLocalJWKSet(devIssuer.jwks);
  throw new Error("No JWKS configured");
}
