import { CheckoutService } from "../../application/checkout/commands/checkout-service.js";
import type { HostedCheckoutProvider } from "../../application/checkout/ports/hosted-checkout-provider.js";
import { CatalogAdminService } from "../../application/checkout/services/catalog-admin-service.js";
import { CatalogService } from "../../application/checkout/services/catalog-service.js";
import { CreditAccountQueryService } from "../../application/credit/services/account-query-service.js";
import { AdminGrantService } from "../../application/credit/services/admin-grant-service.js";
import { GrantExpiryService } from "../../application/credit/services/grant-expiry-service.js";
import { RedeemAdminService } from "../../application/credit/services/redeem-admin-service.js";
import { RedeemService } from "../../application/credit/services/redeem-service.js";
import { SubscriptionGrantService } from "../../application/credit/services/subscription-grant-service.js";
import { BillingAdmissionService } from "../../application/metering/services/billing-admission-service.js";
import { UsagePricingAdminService } from "../../application/metering/services/usage-pricing-admin-service.js";
import { UsagePricingService } from "../../application/metering/services/usage-pricing-service.js";
import { UsageSettlementService } from "../../application/metering/services/usage-settlement-service.js";
import { BillingSettlementService } from "../../application/payment/commands/billing-settlement-service.js";
import { ProviderEventAdminService } from "../../application/payment/commands/provider-event-admin-service.js";
import { ProviderEventInboxService } from "../../application/payment/commands/provider-event-inbox-service.js";
import { ProviderEventProcessor } from "../../application/payment/commands/provider-event-processor.js";
import type { ProviderRegistry } from "../../application/payment/ports/provider-registry.js";
import { ProviderAccountService } from "../../application/payment/queries/provider-account-service.js";
import { AdminStatsService } from "../../application/reconcile/queries/admin-stats-service.js";
import { ReconciliationService } from "../../application/reconcile/services/reconciliation-service.js";
import { BillingReversalService } from "../../application/refund/commands/billing-reversal-service.js";
import { SubscriptionQueryService } from "../../application/subscription/queries/subscription-query-service.js";
import type { SqlConnection } from "./database.js";
import { CheckoutService as PostgresCheckoutRepository } from "./repositories/checkout/checkout-service.js";
import { CatalogAdminService as PostgresCatalogAdminRepository } from "./repositories/checkout/catalog-admin-service.js";
import { CatalogService as PostgresCatalogRepository } from "./repositories/checkout/catalog-service.js";
import { CreditAccountQueryService as PostgresCreditAccountRepository } from "./repositories/credit/account-query-service.js";
import { AdminGrantService as PostgresAdminGrantRepository } from "./repositories/credit/admin-grant-service.js";
import { GrantExpiryService as PostgresGrantExpiryRepository } from "./repositories/credit/grant-expiry-service.js";
import { RedeemAdminService as PostgresRedeemAdminRepository } from "./repositories/credit/redeem-admin-service.js";
import { RedeemService as PostgresRedeemRepository } from "./repositories/credit/redeem-service.js";
import { SubscriptionGrantService as PostgresSubscriptionGrantRepository } from "./repositories/credit/subscription-grant-service.js";
import { BillingAdmissionService as PostgresBillingAdmissionRepository } from "./repositories/metering/billing-admission-service.js";
import { UsagePricingAdminService as PostgresUsagePricingAdminRepository } from "./repositories/metering/usage-pricing-admin-service.js";
import { UsagePricingService as PostgresUsagePricingRepository } from "./repositories/metering/usage-pricing-service.js";
import { UsageSettlementService as PostgresUsageSettlementRepository } from "./repositories/metering/usage-settlement-service.js";
import { BillingSettlementService as PostgresBillingSettlementRepository } from "./repositories/payment/billing-settlement-service.js";
import { ProviderEventAdminService as PostgresProviderEventAdminRepository } from "./repositories/payment/provider-event-admin-service.js";
import { ProviderEventInboxService as PostgresProviderEventInboxRepository } from "./repositories/payment/provider-event-inbox-service.js";
import { ProviderEventProcessor as PostgresProviderEventProcessorRepository } from "./repositories/payment/provider-event-processor.js";
import { ProviderAccountService as PostgresProviderAccountRepository } from "./repositories/payment/provider-account-service.js";
import { AdminStatsService as PostgresAdminStatsRepository } from "./repositories/reconcile/admin-stats-service.js";
import { ReconciliationService as PostgresReconciliationRepository } from "./repositories/reconcile/reconciliation-service.js";
import { BillingReversalService as PostgresBillingReversalRepository } from "./repositories/refund/billing-reversal-service.js";
import { SubscriptionQueryService as PostgresSubscriptionRepository } from "./repositories/subscription/subscription-query-service.js";

export type CheckoutRepositoryOptions = {
  readonly hostedProvider?: HostedCheckoutProvider;
  readonly publicBaseUrl?: string;
};

export const createPostgresCheckoutService = (
  connection: SqlConnection,
  options: CheckoutRepositoryOptions = {},
): CheckoutService =>
  new CheckoutService(
    new PostgresCheckoutRepository(connection, options),
    connection,
  );
export const createPostgresCatalogAdminService = (
  connection: SqlConnection,
): CatalogAdminService =>
  new CatalogAdminService(
    new PostgresCatalogAdminRepository(connection),
    connection,
  );
export const createPostgresCatalogService = (
  connection: SqlConnection,
): CatalogService =>
  new CatalogService(new PostgresCatalogRepository(connection));
export const createPostgresCreditAccountQueryService = (
  connection: SqlConnection,
): CreditAccountQueryService =>
  new CreditAccountQueryService(
    new PostgresCreditAccountRepository(connection),
    connection,
  );
export const createPostgresAdminGrantService = (
  connection: SqlConnection,
): AdminGrantService =>
  new AdminGrantService(
    new PostgresAdminGrantRepository(connection),
    connection,
  );
export const createPostgresGrantExpiryService = (
  connection: SqlConnection,
): GrantExpiryService =>
  new GrantExpiryService(
    new PostgresGrantExpiryRepository(connection),
    connection,
  );
export const createPostgresRedeemAdminService = (
  connection: SqlConnection,
  secret: string,
): RedeemAdminService =>
  new RedeemAdminService(
    new PostgresRedeemAdminRepository(connection, secret),
    connection,
  );
export const createPostgresRedeemService = (
  connection: SqlConnection,
  secret: string,
): RedeemService =>
  new RedeemService(
    new PostgresRedeemRepository(connection, secret),
    connection,
  );
export const createPostgresSubscriptionGrantService = (
  connection: SqlConnection,
): SubscriptionGrantService =>
  new SubscriptionGrantService(
    new PostgresSubscriptionGrantRepository(connection),
    connection,
  );
export const createPostgresUsagePricingAdminService = (
  connection: SqlConnection,
): UsagePricingAdminService =>
  new UsagePricingAdminService(
    new PostgresUsagePricingAdminRepository(connection),
    connection,
  );
export const createPostgresUsagePricingService = (
  connection: SqlConnection,
): UsagePricingService =>
  new UsagePricingService(new PostgresUsagePricingRepository(connection));
export const createPostgresUsageSettlementService = (
  connection: SqlConnection,
): UsageSettlementService =>
  new UsageSettlementService(
    new PostgresUsageSettlementRepository(connection),
    connection,
  );
export const createPostgresBillingAdmissionService = (
  connection: SqlConnection,
  usage: Pick<
    UsageSettlementService,
    | "authorizeUsage"
    | "settleUsage"
    | "releaseUsage"
    | "ensureUsageEventForHold"
  >,
): BillingAdmissionService =>
  new BillingAdmissionService(
    new PostgresBillingAdmissionRepository(connection, usage),
    connection,
  );
export const createPostgresBillingSettlementService = (
  connection: SqlConnection,
): BillingSettlementService =>
  new BillingSettlementService(
    new PostgresBillingSettlementRepository(connection),
    connection,
  );
export const createPostgresProviderEventAdminService = (
  connection: SqlConnection,
): ProviderEventAdminService =>
  new ProviderEventAdminService(
    new PostgresProviderEventAdminRepository(connection),
    connection,
  );
export const createPostgresProviderEventInboxService = (
  connection: SqlConnection,
): ProviderEventInboxService =>
  new ProviderEventInboxService(
    new PostgresProviderEventInboxRepository(connection),
    connection,
  );
export const createPostgresProviderAccountService = (
  connection: SqlConnection,
): ProviderAccountService =>
  new ProviderAccountService(new PostgresProviderAccountRepository(connection));
export const createPostgresBillingReversalService = (
  connection: SqlConnection,
): BillingReversalService =>
  new BillingReversalService(
    new PostgresBillingReversalRepository(connection),
    connection,
  );
export const createPostgresProviderEventProcessor = (
  connection: SqlConnection,
  providers: ProviderRegistry,
  settlement: Pick<
    BillingSettlementService,
    "recordSettlement" | "fulfillSettlement"
  >,
  reversal: Pick<BillingReversalService, "recordReversal" | "reverseCredits">,
  subscriptionGrant: Pick<SubscriptionGrantService, "grant">,
): ProviderEventProcessor =>
  new ProviderEventProcessor(
    new PostgresProviderEventProcessorRepository(
      connection,
      providers,
      settlement,
      reversal,
      subscriptionGrant,
    ),
    connection,
  );
export const createPostgresAdminStatsService = (
  connection: SqlConnection,
): AdminStatsService =>
  new AdminStatsService(new PostgresAdminStatsRepository(connection));
export const createPostgresReconciliationService = (
  connection: SqlConnection,
): ReconciliationService =>
  new ReconciliationService(new PostgresReconciliationRepository(connection));
export const createPostgresSubscriptionQueryService = (
  connection: SqlConnection,
): SubscriptionQueryService =>
  new SubscriptionQueryService(new PostgresSubscriptionRepository(connection));
