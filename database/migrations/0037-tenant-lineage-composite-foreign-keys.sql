-- Cross-context references carry tenant lineage in addition to the opaque id.
ALTER TABLE payment_subscription_period
  ADD CONSTRAINT uq_payment_subscription_period_tenant_id UNIQUE (tenant_id, period_id);
ALTER TABLE payment_provider_account
  ADD CONSTRAINT uq_payment_provider_account_tenant_id UNIQUE (tenant_id, provider_account_id);
ALTER TABLE payment_settlement
  ADD CONSTRAINT uq_payment_settlement_tenant_id UNIQUE (tenant_id, settlement_id);

ALTER TABLE entitlement_credit_grant
  ADD CONSTRAINT fk_entitlement_credit_grant_site_account
    FOREIGN KEY (tenant_id, credit_account_id)
    REFERENCES entitlement_credit_account (tenant_id, credit_account_id);
ALTER TABLE entitlement_subscription_term
  ADD CONSTRAINT fk_entitlement_subscription_term_site_period
    FOREIGN KEY (tenant_id, source_period_id)
    REFERENCES payment_subscription_period (tenant_id, period_id);
ALTER TABLE entitlement_usage_settlement
  ADD CONSTRAINT fk_entitlement_usage_settlement_site_hold
    FOREIGN KEY (tenant_id, credit_hold_id)
    REFERENCES entitlement_credit_hold (tenant_id, credit_hold_id);
ALTER TABLE payment_checkout
  ADD CONSTRAINT fk_payment_checkout_site_offer_revision
    FOREIGN KEY (tenant_id, offer_revision_id)
    REFERENCES entitlement_offer_revision (tenant_id, offer_revision_id);
ALTER TABLE payment_customer_binding
  ADD CONSTRAINT fk_payment_customer_binding_site_provider
    FOREIGN KEY (tenant_id, provider_account_id)
    REFERENCES payment_provider_account (tenant_id, provider_account_id);
ALTER TABLE payment_reversal
  ADD CONSTRAINT fk_payment_reversal_site_settlement
    FOREIGN KEY (tenant_id, settlement_id)
    REFERENCES payment_settlement (tenant_id, settlement_id);
