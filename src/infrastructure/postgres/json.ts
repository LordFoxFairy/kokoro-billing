import { z, type ZodType } from "zod";

export const jsonRecordSchema = z.record(z.string(), z.unknown());

export class PersistedDataInvariantError extends Error {
  public override readonly name = "PersistedDataInvariantError";
  public readonly code = "billing.internal_error";
  public readonly statusCode = 500;

  public constructor(public readonly internalCode: string) {
    super(internalCode);
  }
}

/** Validate JSON/JSONB at the persistence boundary before it reaches a handler. */
export const parsePersistedJson = <T>(
  value: unknown,
  schema: ZodType<T>,
  errorCode: string,
): T => {
  let parsed: unknown;
  try {
    parsed = typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    throw new PersistedDataInvariantError(errorCode);
  }
  const result = schema.safeParse(parsed);
  if (!result.success) throw new PersistedDataInvariantError(errorCode);
  return result.data;
};
