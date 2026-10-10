import { z } from "zod";

const boolStr = z
  .enum(["true", "false"])
  .default("false")
  .transform((v) => v === "true");

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().default(4018),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),

    DATABASE_URL: z.string().min(1),
    DB_POOL_MAX: z.coerce.number().int().positive().default(10),

    JWT_ISSUER: z.string().min(1).default("http://localhost:4018/dev"),
    JWT_AUDIENCE: z.string().min(1).default("website-builder-api"),
    JWT_JWKS_URL: z.string().url().optional(),
    DEV_AUTH_ENABLED: boolStr,
    PREVIEW_TOKEN_SECRET: z.string().min(32, "required, at least 32 characters (set it in .env)"),

    INTEGRATIONS_MODE: z.enum(["mock", "http"]).default("mock"),
    IDENTITY_API_URL: z.string().url().optional(),
    WEBSITE_API_URL: z.string().url().optional(),
    PAGE_API_URL: z.string().url().optional(),
    THEME_API_URL: z.string().url().optional(),
    MEDIA_API_URL: z.string().url().optional(),
    INTEGRATIONS_SERVICE_TOKEN: z.string().optional(),

    TEMPLATE_MAX_DOCUMENT_BYTES: z.coerce.number().int().positive().default(2_097_152),
    TEMPLATE_APPLY_JOB_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
    RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(120),
    CORS_ALLOWED_ORIGINS: z.string().default(""),

    OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5_000),
    OUTBOX_WEBHOOK_URL: z.string().url().optional(),
  })
  .superRefine((c, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
    if (!c.DEV_AUTH_ENABLED && !c.JWT_JWKS_URL) issue("JWT_JWKS_URL", "required unless DEV_AUTH_ENABLED=true");
    if (c.NODE_ENV === "production") {
      if (c.DEV_AUTH_ENABLED) issue("DEV_AUTH_ENABLED", "must be false in production");
      if (c.INTEGRATIONS_MODE !== "http") issue("INTEGRATIONS_MODE", "must be 'http' in production");
    }
    if (c.INTEGRATIONS_MODE === "http") {
      for (const k of ["IDENTITY_API_URL", "WEBSITE_API_URL", "PAGE_API_URL", "THEME_API_URL", "MEDIA_API_URL"] as const) {
        if (!c[k]) issue(k, "required when INTEGRATIONS_MODE=http");
      }
    }
  });

export type Config = z.infer<typeof schema>;

/** Validates the environment and fails fast with a readable message. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ""));
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${lines.join("\n")}`);
  }
  return parsed.data;
}
