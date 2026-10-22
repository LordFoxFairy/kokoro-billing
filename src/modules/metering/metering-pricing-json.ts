import { BadRequestException } from "@nestjs/common";

/** Native JSON checks syntax; the token walk retains every decoded object name
 * before JSON.parse's last-key-wins can erase conflicting command intent. */
export function parseMeteringPricingJson(raw: Buffer): unknown {
  try {
    if (raw.length === 0 || raw.length > 1_048_576) throw new Error();
    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(raw);
    const value: unknown = JSON.parse(text);
    const tokens = text.match(/"(?:[^"\\]|\\[\s\S])*"|[{}[\]:,]/gu) ?? [];
    const stack: (Set<string> | null)[] = [];
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index];
      if (token === "{" || token === "[") {
        stack.push(token === "{" ? new Set() : null);
        if (stack.length > 12) throw new Error();
      } else if (token === "}" || token === "]") stack.pop();
      else if (tokens[index + 1] === ":") {
        const scope = stack.at(-1);
        const name: unknown = JSON.parse(token ?? "null");
        if (
          scope === null ||
          scope === undefined ||
          typeof name !== "string" ||
          scope.has(name)
        )
          throw new Error();
        scope.add(name);
      }
    }
    return value;
  } catch {
    throw new BadRequestException();
  }
}
