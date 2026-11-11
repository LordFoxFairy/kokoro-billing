import { BadRequestException } from "@nestjs/common";
/** Flat string commands preserve UTF-8 and reject
 * duplicate decoded names before native JSON parsing can discard a command. */
export function parseFlatStringCommandJson(raw: Buffer): unknown {
  if (raw.length === 0 || raw.length > 16384) throw new BadRequestException();
  let value: unknown;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      raw,
    );
    value = JSON.parse(text) as unknown;
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.values(value).some((item) => typeof item !== "string")
    )
      throw new Error();
    const tokens = text.match(/"(?:[^"\\]|\\[\s\S])*"/gu) ?? [];
    const names = new Set<string>();
    for (let index = 0; index < tokens.length; index += 2) {
      const name: unknown = JSON.parse(tokens[index] ?? "null");
      if (typeof name !== "string" || names.has(name)) throw new Error();
      names.add(name);
    }
    if (
      tokens.length !== names.size * 2 ||
      names.size !== Object.keys(value).length
    )
      throw new Error();
  } catch {
    throw new BadRequestException();
  }
  return value;
}
