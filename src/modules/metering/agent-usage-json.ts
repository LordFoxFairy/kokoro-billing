import { agentUsageSchema } from "../../generated/agent-usage-v2/schema.gen.js";
import { AgentUsageEvidenceError } from "./agent-usage-evidence.error.js";

export type UsageJson =
  null | boolean | string | UsageJson[] | { [key: string]: UsageJson };

export type BoundJson =
  null | boolean | string | 1 | BoundJson[] | { [key: string]: BoundJson };

// Numeric permission is lexical, limited to one root property of a bound.
function parseAgentJson(
  raw: Uint8Array,
  maxBytes: number,
  boundVersion = false,
): Readonly<{ text: string; value: BoundJson }> {
  if (raw.byteLength > maxBytes) throw new AgentUsageEvidenceError();
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
  const value = (depth: number, key?: string): BoundJson => {
    if (depth > agentUsageSchema["x-max-json-depth"]) return fail();
    whitespace();
    const char = text[offset];
    if (char === '"') return string();
    if (char === "{") {
      offset++;
      whitespace();
      const result: { [key: string]: BoundJson } = Object.create(null) as {
        [key: string]: BoundJson;
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
        result[key] = value(depth + 1, key);
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
      const result: BoundJson[] = [];
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
    if (
      boundVersion &&
      depth === 2 &&
      key === "final_request_binding_version" &&
      char === "1" &&
      /[ ,}\n\r\t]/u.test(text[offset + 1] ?? "!")
    ) {
      offset++;
      return 1;
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

/** Preserve the published usage2 budget; the HTTP wrapper never enlarges it. */
export function parseAgentUsageJson(raw: Uint8Array) {
  return parseAgentJson(raw, agentUsageSchema["x-max-json-bytes"]) as Readonly<{
    text: string;
    value: UsageJson;
  }>;
}

export const MAX_AGENT_EVIDENCE_RESPONSE_BYTES = 98_304;
export function parseAgentEvidenceEnvelopeJson(raw: Uint8Array) {
  return parseAgentJson(raw, MAX_AGENT_EVIDENCE_RESPONSE_BYTES) as Readonly<{
    text: string;
    value: UsageJson;
  }>;
}

/** RFC8785 on the finite, validated usage2 value set; never locale-sort keys. */
export function canonicalAgentUsageJson(value: UsageJson): string {
  return canonicalAgentBoundJson(value);
}

export const MAX_AGENT_BOUND_RESPONSE_BYTES = 196_608;
export function parseAgentBoundEnvelopeJson(raw: Uint8Array) {
  return parseAgentJson(raw, MAX_AGENT_BOUND_RESPONSE_BYTES);
}
export function parseAgentBoundJson(raw: Uint8Array) {
  return parseAgentJson(raw, 65_536, true);
}

/** RFC8785 for the bound's finite type set, including its single integer literal. */
export function canonicalAgentBoundJson(value: BoundJson): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map(canonicalAgentBoundJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalAgentBoundJson(value[key] ?? null)}`,
    )
    .join(",")}}`;
}
