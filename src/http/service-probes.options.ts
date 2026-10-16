/** Infrastructure-only readiness capability; never exposes ORM or owner rows. */
export const BILLING_PG_READINESS = Symbol("BILLING_PG_READINESS");
export type BillingPgReadiness = Readonly<{ ping(): Promise<void> }>;
