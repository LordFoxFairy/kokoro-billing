import { agentUsageSchema } from "../../generated/agent-usage-v2/schema.gen.js";
import { AgentUsageEvidenceError } from "./agent-usage-evidence.error.js";

export type UsageJson =
  null | boolean | string | UsageJson[] | { [key: string]: UsageJson };

/** The published usage2 schema has no JSON numbers. Never round a wire count. */
export function parseAgentUsageJson(
  raw: Uint8Array,
): Readonly<{ text: string; value: UsageJson }> {
  if (raw.byteLength > agentUsageSchema["x-max-json-bytes"])
    throw new AgentUsageEvidenceError();
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      raw,
    );
  } catch {
    throw new AgentUsageEvidenceError();
  }
  let offset = 0;
  const fail = (): never => {
    throw new AgentUsageEvidenceError();
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
  const value = (depth: number): UsageJson => {
    if (depth > agentUsageSchema["x-max-json-depth"]) return fail();
    whitespace();
    const char = text[offset];
    if (char === '"') return string();
    if (char === "{") {
      offset++;
      whitespace();
      const result: { [key: string]: UsageJson } = Object.create(null) as {
        [key: string]: UsageJson;
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
      const result: UsageJson[] = [];
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
    return fail();
  };
  const parsed = value(1);
  whitespace();
  if (offset !== text.length) return fail();
  return { text, value: parsed };
}

/** RFC8785 on the finite, validated usage2 value set; never locale-sort keys. */
export function canonicalAgentUsageJson(value: UsageJson): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map(canonicalAgentUsageJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalAgentUsageJson(value[key] ?? null)}`,
    )
    .join(",")}}`;
}
