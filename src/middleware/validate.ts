import type { ZodTypeAny, z } from "zod";
import { validationError } from "../errors";

/** Validates params/query/body and throws a 400 VALIDATION_ERROR with per-field details. */
export function validate<S extends ZodTypeAny>(schema: S, data: unknown): z.output<S> {
  const result = schema.safeParse(data ?? {});
  if (!result.success) {
    throw validationError(
      "Request validation failed.",
      result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  return result.data;
}
