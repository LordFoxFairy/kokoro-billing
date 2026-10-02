import type { FastifyRequest } from "fastify";

export type BillingUserContext = Readonly<{
  tenantId: string;
  subjectId: string;
}>;
export type BillingInternalContext = Readonly<{
  tenantId: string;
  serviceId: string;
}>;
export type BillingBffContext = Readonly<{
  tenantId: string;
  serviceId: "web-bff";
  subjectId?: string;
}>;
export type BillingAdminContext = Readonly<{
  tenantId: string;
  operatorId: string;
  role: string;
}>;
export type BillingAuth = Readonly<{
  user(request: FastifyRequest): Promise<BillingUserContext | null>;
  internal(request: FastifyRequest): Promise<BillingInternalContext | null>;
  bff(request: FastifyRequest): Promise<BillingBffContext | null>;
  admin(request: FastifyRequest): Promise<BillingAdminContext | null>;
  webhook(request: FastifyRequest): Promise<boolean>;
}>;
export type BillingAuthOptions = Readonly<{
  mode: "internal-header" | "jwks";
  internalServiceSecret: string;
  bffServiceToken: string;
  operatorProxySecret: string;
  jwksUrl?: string;
  issuer: string;
  audience?: string;
}>;
export type BillingIdentityKind = "tenant" | "subject";
export type BillingPersonalHttpOptions = Omit<
  BillingAuthOptions,
  "mode" | "jwksUrl" | "audience"
> &
  Readonly<{ mode: "jwks"; jwksUrl: string; audience: string }>;
export type BillingPersonalAuthResult =
  | Readonly<{ ok: true; context: BillingUserContext }>
  | Readonly<{ ok: false; status: 400 | 401 | 403 }>;
export type BillingPersonalAuth = Readonly<{
  authenticate(request: FastifyRequest): Promise<BillingPersonalAuthResult>;
}>;
export type BillingSchemaValidator = Readonly<{
  names: readonly string[];
  assert(
    name: "CreditAccountResponse" | "CreditLedgerResponse" | "ErrorResponse",
    value: unknown,
  ): void;
}>;
// Runtime tokens and their types form this HTTP boundary's single DI contract.
export const BILLING_PERSONAL_HTTP_OPTIONS = Symbol(
  "BILLING_PERSONAL_HTTP_OPTIONS",
);
export const BILLING_PERSONAL_AUTH = Symbol("BILLING_PERSONAL_AUTH");
export const BILLING_SCHEMA_VALIDATOR = Symbol("BILLING_SCHEMA_VALIDATOR");
declare module "fastify" {
  interface FastifyRequest {
    billingPersonalContext?: BillingUserContext;
  }
}
