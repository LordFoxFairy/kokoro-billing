export type MeteringJson =
  | null
  | boolean
  | string
  | 1
  | MeteringJson[]
  | { [key: string]: MeteringJson };

// Shared bounded parser for evidence and credential snapshots; schema validation stays with each consumer.
export function parseStrictMeteringJson(
  raw: Uint8Array,
  maxBytes: number,
  maxDepth: number,
  allowNumericOne = false,
): Readonly<{ text: string; value: MeteringJson }> {
  if (raw.byteLength > maxBytes) throw new Error("Invalid metering JSON");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      raw,
    );
  } catch {
    throw new Error("Invalid metering JSON");
  }
  let offset = 0;
  const fail = (): never => {
    throw new Error("Invalid metering JSON");
  };
  const whitespace = (): void => {
    while (/[ \n\r\t]/u.test(text[offset] ?? "!")) offset++;
  };
  const string = (): string => {
    if (text[offset] !== '"') return fail();
    const start = offset++;
    while (offset < text.length) {
      const char = text[offset++];
      if (char === "\\") {
        offset++;
        continue;
      }
      if (char !== '"') continue;
      let result: unknown;
      try {
        result = JSON.parse(text.slice(start, offset));
      } catch {
        return fail();
      }
      if (
        typeof result !== "string" ||
        [...result].some((character) => {
          const point = character.codePointAt(0) ?? 0;
          return (
            point < 32 || point === 127 || (point >= 0xd800 && point <= 0xdfff)
          );
        })
      )
        return fail();
      return result;
    }
    return fail();
  };
  const value = (depth: number): MeteringJson => {
    if (depth > maxDepth) return fail();
    whitespace();
    const char = text[offset];
    if (char === '"') return string();
    if (char === "{") {
      offset++;
      whitespace();
      const result: { [key: string]: MeteringJson } = Object.create(null) as {
        [key: string]: MeteringJson;
      };
      if (text[offset] === "}") {
        offset++;
        return result;
      }
      while (offset < text.length) {
        whitespace();
        const key = string();
        if (Object.hasOwn(result, key)) return fail();
        whitespace();
        if (text[offset++] !== ":") return fail();
        result[key] = value(depth + 1);
        whitespace();
        const separator = text[offset++];
        if (separator === "}") return result;
        if (separator !== ",") return fail();
      }
      return fail();
    }
    if (char === "[") {
      offset++;
      whitespace();
      const result: MeteringJson[] = [];
      if (text[offset] === "]") {
        offset++;
        return result;
      }
      while (offset < text.length) {
        result.push(value(depth + 1));
        whitespace();
        const separator = text[offset++];
        if (separator === "]") return result;
        if (separator !== ",") return fail();
      }
      return fail();
    }
    for (const [token, literal] of [
      ["null", null],
      ["true", true],
      ["false", false],
    ] as const) {
      if (text.startsWith(token, offset)) {
        offset += token.length;
        return literal;
      }
    }
    if (allowNumericOne) {
      const lexeme =
        /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(
          text.slice(offset),
        )?.[0];
      if (lexeme !== undefined && Number(lexeme) === 1) {
        offset += lexeme.length;
        return 1;
      }
    }
    return fail();
  };
  const parsed = value(1);
  whitespace();
  if (offset !== text.length) return fail();
  return { text, value: parsed };
}
