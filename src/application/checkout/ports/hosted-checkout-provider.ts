export type HostedCheckoutInput = {
  readonly checkoutId: string;
  /** External contract vocabulary; persistence translates tenantId to tenant_id. */
  readonly tenantId: string;
  readonly subjectId: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly billingInterval: 'once' | 'month' | 'year';
  readonly productName: string;
  readonly successUrl: string;
  readonly cancelUrl: string;
};

export type HostedCheckoutSession = { readonly provider: string; readonly sessionId: string; readonly checkoutUrl: string; readonly providerAccountRef?: string | null };

export interface HostedCheckoutProvider {
  readonly provider: string;
  readonly providerAccountRef?: string | null;
  createSession(input: HostedCheckoutInput): Promise<HostedCheckoutSession>;
}
