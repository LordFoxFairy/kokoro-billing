import { z } from "zod";
import { AgentUsageReaderError } from "./agent-usage-evidence-reader.error.js";

const schema = z
  .object({
    baseUrl: z
      .string()
      .url()
      .transform((value, context) => {
        const url = new URL(value);
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.username ||
          url.password ||
          !["", "/"].includes(url.pathname) ||
          url.search ||
          url.hash
        ) {
          context.addIssue({ code: "custom", message: "Invalid Agent origin" });
          return z.NEVER;
        }
        return url.origin;
      }),
    machineBearerToken: z
      .string()
      .min(1)
      .max(16_384)
      .regex(/^[A-Za-z0-9._~+/-]+=*$/u),
    deadlineMs: z.number().int().min(1).max(2_147_483_647),
  })
  .strict();
export type AgentUsageReaderOptions = z.input<typeof schema>;
export function resolveAgentUsageReaderOptions(value: AgentUsageReaderOptions) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AgentUsageReaderError("CONFIG_INVALID");
  const result = Object.create(null) as z.output<typeof schema>;
  Object.defineProperties(result, {
    baseUrl: { value: parsed.data.baseUrl, enumerable: true },
    machineBearerToken: {
      value: parsed.data.machineBearerToken,
      enumerable: false,
    },
    deadlineMs: { value: parsed.data.deadlineMs, enumerable: true },
  });
  return Object.freeze(result);
}
