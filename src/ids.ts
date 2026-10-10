import { z } from "zod";
import { AppError } from "./errors";

const MAX_BIGINT = 9223372036854775807n;

/** A positive PostgreSQL BIGINT as a decimal string. JSON numbers are rejected on purpose. */
export const bigIdSchema = z
  .string()
  .regex(/^[0-9]{1,19}$/, "must be a decimal string")
  .refine((v) => {
    if (!/^[0-9]{1,19}$/.test(v)) return true; // already reported by the regex above; BigInt() would throw
    const n = BigInt(v);
    return n > 0n && n <= MAX_BIGINT;
  }, "must be between 1 and 9223372036854775807");

export function parseId(value: unknown, name: string): string {
  const r = bigIdSchema.safeParse(value);
  if (!r.success) {
    throw new AppError(400, "INVALID_ID", `${name} must be a positive decimal BIGINT string.`, { field: name });
  }
  return r.data;
}
