import { z } from "zod";

export const BILLING_ACCESS_RESOURCE = "https://kokoro.dev/resources/billing";
export const BILLING_ACCESS_SCOPE = "billing:credit.consume";
export const BILLING_TOKEN_KIND_CLAIM = "https://kokoro.dev/token_kind";
export const BILLING_TENANT_CLAIM = "https://kokoro.dev/tenant_id";
export const BILLING_OPERATOR_CLAIM = "https://kokoro.dev/operator";

const oidcScopes = ["openid", "profile", "email", "offline_access"] as const;
const permittedScopes = new Set<string>([BILLING_ACCESS_SCOPE, ...oidcScopes]);

export const billingAccessTokenClaimsSchema = z
  .object({
    iss: z.string().url(),
    aud: z.union([z.string().min(1), z.array(z.string().min(1)).min(1).max(2)]),
    sub: z.string().min(1),
    sid: z.string().min(1),
    client_id: z.string().min(1),
    exp: z.number().int().safe().positive(),
    iat: z.number().int().safe().nonnegative(),
    nbf: z.number().int().safe().nonnegative().optional(),
    scope: z.string().min(1),
    [BILLING_TOKEN_KIND_CLAIM]: z.literal("user_delegated"),
    [BILLING_TENANT_CLAIM]: z.string().min(1),
    [BILLING_OPERATOR_CLAIM]: z.never().optional(),
    cnf: z.never().optional(),
  })
  .superRefine((value, context) => {
    const audiences = Array.isArray(value.aud) ? value.aud : [value.aud];
    const scopes = value.scope.split(" ").filter(Boolean);
    const expectedAudiences = scopes.includes("openid")
      ? [BILLING_ACCESS_RESOURCE, value.iss + "/oauth2/userinfo"]
      : [BILLING_ACCESS_RESOURCE];
    if (
      new Set(audiences).size !== audiences.length ||
      audiences.length !== expectedAudiences.length ||
      expectedAudiences.some((audience) => !audiences.includes(audience))
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Unexpected audience",
        path: ["aud"],
      });
    if (
      !scopes.includes(BILLING_ACCESS_SCOPE) ||
      new Set(scopes).size !== scopes.length ||
      scopes.some((scope) => !permittedScopes.has(scope))
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Unexpected scope",
        path: ["scope"],
      });
  });

export type BillingAccessTokenClaims = z.infer<
  typeof billingAccessTokenClaimsSchema
>;
