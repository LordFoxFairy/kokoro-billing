import { z, type ZodType } from 'zod';

export const jsonRecordSchema = z.record(z.string(), z.unknown());

/** Validate JSON/JSONB at the persistence boundary before it reaches a handler. */
export const parsePersistedJson = <T>(value: unknown, schema: ZodType<T>, errorCode: string): T => {
  let parsed: unknown;
  try {
    parsed = typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    throw new Error(errorCode);
  }
  const result = schema.safeParse(parsed);
  if (!result.success) throw new Error(errorCode);
  return result.data;
};
