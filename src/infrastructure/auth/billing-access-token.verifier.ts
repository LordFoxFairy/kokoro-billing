import { createRemoteJWKSet, jwtVerify } from "jose";
import { assertBillingIdentity } from "./billing-identity-header.js";
import type { BillingUserContext } from "./billing-auth.types.js";
import {
  BILLING_ACCESS_RESOURCE,
  BILLING_TENANT_CLAIM,
  billingAccessTokenClaimsSchema,
} from "./billing-access-token-claims.schema.js";

export type BillingAccessTokenVerifier = Readonly<{
  verify(token: string): Promise<BillingUserContext | null>;
}>;

export function createBillingAccessTokenVerifier(options: {
  readonly jwksUrl: string;
  readonly issuer: string;
  readonly audience: string;
}): BillingAccessTokenVerifier {
  if (options.audience !== BILLING_ACCESS_RESOURCE)
    throw new Error(
      `Billing access token audience must be ${BILLING_ACCESS_RESOURCE}`,
    );
  const jwks = createRemoteJWKSet(new URL(options.jwksUrl), {
    timeoutDuration: 2_000,
    cacheMaxAge: 300_000,
    cooldownDuration: 10_000,
  });
  return Object.freeze({
    verify: async (token) => {
      try {
        const verification = await jwtVerify(token, jwks, {
          algorithms: ["EdDSA"],
          issuer: options.issuer,
          audience: BILLING_ACCESS_RESOURCE,
          requiredClaims: [
            "exp",
            "iat",
            "sub",
            "sid",
            "client_id",
            "scope",
            "https://kokoro.dev/token_kind",
            BILLING_TENANT_CLAIM,
          ],
        });
        if (
          verification.protectedHeader.alg !== "EdDSA" ||
          typeof verification.protectedHeader.kid !== "string" ||
          verification.protectedHeader.kid.length === 0
        )
          return null;
        const claims = billingAccessTokenClaimsSchema.safeParse(
          verification.payload,
        );
        if (!claims.success) return null;
        const tenantId = claims.data[BILLING_TENANT_CLAIM];
        const subjectId = claims.data.sub;
        assertBillingIdentity(tenantId, "tenant");
        assertBillingIdentity(subjectId, "subject");
        return Object.freeze({ tenantId, subjectId });
      } catch {
        return null;
      }
    },
  });
}
