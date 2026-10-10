export type RequestContext = {
  userId: bigint;
  tenantId: bigint;
  organizationId: bigint;
  roles: string[];
  permissions: string[];
  requestId: string;
  /** Raw bearer token, forwarded to downstream services only. Never log it. */
  accessToken?: string;
};

export const PERMISSIONS = [
  "template:read",
  "template:create",
  "template:update",
  "template:publish",
  "template:archive",
  "template:apply",
  "template:admin",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const isAdmin = (ctx: RequestContext) => ctx.permissions.includes("template:admin");
