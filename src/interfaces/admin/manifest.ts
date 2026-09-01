import { adminModuleManifestSchema, type AdminModuleManifest } from './schema.js';

// Admin manifest is the gateway contract, not documentation. Every read route
// is a real array endpoint; every mutation is declared with its exact method.
export const billingAdminManifest: AdminModuleManifest = adminModuleManifestSchema.parse({
  id: 'billing',
  labelKey: 'admin.modules.billing',
  basePath: '/admin/billing',
  requiredPermission: 'billing.admin',
  navItems: [
    { id: 'billing', labelKey: 'admin.billing.nav', route: '/billing', requiredPermission: 'billing.admin' },
  ],
  resources: [
    {
      id: 'plans', labelKey: 'admin.billing.resources.plans', route: '/admin/billing/plans', requiredPermission: 'billing.plan.read',
      actions: [{ id: 'publish', labelKey: 'admin.billing.actions.publishPlan', kind: 'mutation', requiredPermission: 'billing.plan.write', route: '/admin/billing/plans', method: 'POST' }],
    },
    {
      id: 'usage-pricing', labelKey: 'admin.billing.resources.usagePricing', route: '/admin/billing/usage-pricing', requiredPermission: 'billing.pricing.read',
      actions: [{ id: 'publish', labelKey: 'admin.billing.actions.publishUsagePricing', kind: 'mutation', requiredPermission: 'billing.pricing.write', route: '/admin/billing/usage-pricing', method: 'POST' }],
    },
    {
      id: 'provider-events', labelKey: 'admin.billing.resources.providerEvents', route: '/admin/billing/provider-events', requiredPermission: 'billing.provider-event.read',
      actions: [{ id: 'retry', labelKey: 'admin.billing.actions.retryProviderEvent', kind: 'mutation', requiredPermission: 'billing.provider-event.retry', route: '/admin/billing/provider-events/:providerEventId/retry', method: 'POST' }],
    },
    {
      id: 'credit-operations', labelKey: 'admin.billing.resources.creditOperations', route: '/admin/billing/credit-operations', requiredPermission: 'billing.credit.read',
      actions: [
        { id: 'grant', labelKey: 'admin.billing.actions.grantCredit', kind: 'dangerMutation', requiredPermission: 'billing.credit.grant', route: '/admin/billing/grants', method: 'POST' },
        { id: 'refund', labelKey: 'admin.billing.actions.refundSettlement', kind: 'dangerMutation', requiredPermission: 'billing.refund.write', route: '/admin/billing/refunds/:settlementId', method: 'POST' },
      ],
    },
    {
      id: 'payment-operations', labelKey: 'admin.billing.resources.paymentOperations', route: '/admin/billing/payment-operations', requiredPermission: 'billing.payment.read',
      actions: [{ id: 'refund', labelKey: 'admin.billing.actions.refundSettlement', kind: 'dangerMutation', requiredPermission: 'billing.refund.write', route: '/admin/billing/refunds/:settlementId', method: 'POST' }],
    },
  ],
});
