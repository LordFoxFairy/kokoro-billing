import { createHash } from "node:crypto";
function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "bigint" || typeof value === "number")
    return JSON.stringify(String(value));
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  throw new TypeError("Command payload is not canonicalizable");
}
export function commandDigest(
  value: Readonly<Record<string, unknown>>,
): string {
  return createHash("sha256").update(canonical(value), "utf8").digest("hex");
}
