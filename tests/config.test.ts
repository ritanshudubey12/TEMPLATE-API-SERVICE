import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/env";

const base = { DATABASE_URL: "postgresql://u:p@localhost:5432/x", PREVIEW_TOKEN_SECRET: "x".repeat(32) };

describe("environment validation", () => {
  it("fails fast without a database url", () => {
    expect(() => loadConfig({ DEV_AUTH_ENABLED: "true" })).toThrow(/DATABASE_URL/);
  });

  it("requires a JWKS URL unless dev auth is on", () => {
    expect(() => loadConfig({ ...base })).toThrow(/JWT_JWKS_URL/);
    expect(loadConfig({ ...base, DEV_AUTH_ENABLED: "true" }).PORT).toBe(4018);
  });

  it("refuses dev auth and mock integrations in production", () => {
    expect(() =>
      loadConfig({ ...base, NODE_ENV: "production", DEV_AUTH_ENABLED: "true", JWT_JWKS_URL: "https://idp.example/jwks.json" }),
    ).toThrow(/DEV_AUTH_ENABLED[\s\S]*INTEGRATIONS_MODE|INTEGRATIONS_MODE[\s\S]*DEV_AUTH_ENABLED/);
  });

  it("requires a preview token secret (no built-in default)", () => {
    expect(() => loadConfig({ DATABASE_URL: base.DATABASE_URL, DEV_AUTH_ENABLED: "true" })).toThrow(/PREVIEW_TOKEN_SECRET/);
  });

  it("treats empty strings as unset", () => {
    expect(loadConfig({ ...base, DEV_AUTH_ENABLED: "true", JWT_JWKS_URL: "" }).JWT_JWKS_URL).toBeUndefined();
  });
});
