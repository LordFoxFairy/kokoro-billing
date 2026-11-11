import { isAbsolute } from "node:path";
import { z } from "zod";

export const IAM_BILLING_AUTHORIZATION_OPTIONS = Symbol(
  "IAM_BILLING_AUTHORIZATION_OPTIONS",
);

export type AuthorizeIamBillingInput = Readonly<{
  tenantId: string;
  payerUserId: string;
  runId: string;
  executionSessionId: string;
  leaseGeneration: string;
  requestBindingSha256: string;
  executionProof: string;
  requestId: string;
  signal: AbortSignal;
}>;

export type IamBillingAuthorization = Readonly<{
  payerUserId: string;
  expiresAt: string;
}>;

export const iamBillingAuthorizationOptionsSchema = z
  .object({
    baseUrl: z
      .string()
      .url()
      .transform((raw, context) => {
        const url = new URL(raw);
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.username.length > 0 ||
          url.password.length > 0 ||
          !["", "/"].includes(url.pathname) ||
          url.search.length > 0 ||
          url.hash.length > 0
        ) {
          context.addIssue({
            code: "custom",
            message: "IAM base URL is invalid",
          });
          return z.NEVER;
        }
        return url.href.replace(/\/$/u, "");
      }),
    serviceCredentialFile: z
      .string()
      .min(1)
      .refine(isAbsolute, "Expected absolute credential file path"),
    deadlineMs: z.number().int().positive().max(2_147_483_647),
  })
  .strict();

export type IamBillingAuthorizationOptions = z.input<
  typeof iamBillingAuthorizationOptionsSchema
>;

export type ResolvedIamBillingAuthorizationOptions = Readonly<{
  baseUrl: string;
  serviceCredentialFile: string;
  deadlineMs: number;
}>;

export function resolveIamBillingAuthorizationOptions(
  value: IamBillingAuthorizationOptions,
): ResolvedIamBillingAuthorizationOptions {
  const parsed = iamBillingAuthorizationOptionsSchema.parse(value);
  const resolved = Object.create(null) as Record<PropertyKey, unknown>;
  Object.defineProperties(resolved, {
    baseUrl: { value: parsed.baseUrl, enumerable: true },
    serviceCredentialFile: {
      value: parsed.serviceCredentialFile,
      enumerable: false,
    },
    deadlineMs: { value: parsed.deadlineMs, enumerable: true },
  });
  return Object.freeze(resolved) as ResolvedIamBillingAuthorizationOptions;
}
