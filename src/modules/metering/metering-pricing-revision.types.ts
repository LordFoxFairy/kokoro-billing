/** Billing-internal publication drafts, not Agent wire or executable quotes.
 * A version/digest reference carries no proof of publication or authorization.
 */
export type MeteringRevisionReference = Readonly<{
  version: string;
  artifactDigest: string;
}>;

/** Canonical decimal strings, reduced, nonnegative numerator, positive denominator. */
export type MeteringRevisionRational = Readonly<{
  numerator: string;
  denominator: string;
}>;

export type MeteringRateApplicability =
  | Readonly<{ kind: "all" }>
  | Readonly<{
      kind: "range";
      dimension: string;
      unit: string;
      lowerInclusive: string;
      /** null means an open upper bound, not unknown usage. */
      upperExclusive: string | null;
    }>;

export type MeteringRevisionRate = Readonly<{
  providerRef: string;
  environment: string;
  pricingAccountRef: string;
  modelRef: string;
  modelVersion: string;
  bucket: string;
  unit: string;
  applicability: MeteringRateApplicability;
  currencyCode: string;
  minorPerUnit: MeteringRevisionRational;
}>;

export type MeteringRateRevisionDraft = Readonly<{
  schemaVersion: "1";
  tenantId: string;
  effectiveFrom: string;
  sourceRef: string;
  verifiedAt: string;
  profileRef: MeteringRevisionReference;
  rates: readonly MeteringRevisionRate[];
}>;

export type MeteringPolicyRevisionDraft = Readonly<{
  schemaVersion: "1";
  tenantId: string;
  effectiveFrom: string;
  sourceRef: string;
  verifiedAt: string;
  profileRef: MeteringRevisionReference;
  currencyCode: string;
  multiplier: MeteringRevisionRational;
  creditMicrosPerMinor: MeteringRevisionRational;
  roundingVersion: "attempt-ceil-v1";
  /** Explicitly pending/nonexecutable when null; never an implicit free/charge policy.
   * A non-null reference also requires owner validation before execution.
   */
  failurePolicyRef: MeteringRevisionReference | null;
}>;

export type MeteringPublicationCommand<Draft> = Readonly<{
  tenantId: string;
  actorId: string;
  publicationIdentity: string;
  idempotencyKey: string;
  reason: string;
  draft: Draft;
}>;

export type MeteringRevisionEncoding = Readonly<{
  canonicalJson: string;
  contentDigest: string;
}>;

/** Pure receipt inputs only: no publication, persistence, replay or authorization. */
export type MeteringPublicationEncoding = Readonly<{
  tenantId: string;
  namespace: "general";
  apiSurface: "internal";
  commandName:
    "metering.publish_rate_revision" | "metering.publish_policy_revision";
  commandIdentity: string;
  idempotencyKey: string;
  requestSchemaVersion: 1;
  canonicalJson: string;
  contentDigest: string;
  payloadDigest: string;
}>;
