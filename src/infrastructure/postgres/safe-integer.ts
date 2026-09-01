/** Convert a PostgreSQL BIGINT value without allowing silent JavaScript precision loss. */
export function readSafeInteger(value: unknown, field: string): number {
  const number = typeof value === 'bigint' ? Number(value) : Number(String(value));
  if (!Number.isSafeInteger(number)) throw new Error(`billing.${field}_precision`);
  return number;
}
