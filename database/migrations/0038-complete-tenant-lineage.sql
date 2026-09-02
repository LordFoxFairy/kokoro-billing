-- Every Billing cross-context reference carries tenant lineage.
-- The opaque identifier alone is never sufficient for a relational link.

ALTER TABLE entitlement_usage_event
  ADD CONSTRAINT uq_entitlement_usage_event_tenant_id UNIQUE (tenant_id, usage_event_id);
ALTER TABLE entitlement_acquisition
  ADD CONSTRAINT uq_entitlement_acquisition_tenant_id UNIQUE (tenant_id, acquisition_id);
ALTER TABLE entitlement_fulfillment
  ADD CONSTRAINT uq_entitlement_fulfillment_tenant_id UNIQUE (tenant_id, fulfillment_id);
ALTER TABLE payment_provider_event
  ADD CONSTRAINT uq_payment_provider_event_tenant_id UNIQUE (tenant_id, provider_event_id);
ALTER TABLE payment_reversal
  ADD CONSTRAINT uq_payment_reversal_tenant_id UNIQUE (tenant_id, reversal_id);
ALTER TABLE entitlement_offer
  ADD CONSTRAINT uq_entitlement_offer_tenant_id UNIQUE (tenant_id, offer_id);
ALTER TABLE entitlement_usage_price_revision
  ADD CONSTRAINT uq_entitlement_usage_price_revision_tenant_id UNIQUE (tenant_id, usage_price_revision_id);
ALTER TABLE payment_provider_subscription
  ADD CONSTRAINT uq_payment_provider_subscription_tenant_id UNIQUE (tenant_id, provider_subscription_id);
ALTER TABLE entitlement_redeem_campaign
  ADD CONSTRAINT uq_redeem_campaign_tenant_id UNIQUE (tenant_id, campaign_id);
ALTER TABLE entitlement_redeem_code_batch
  ADD CONSTRAINT uq_redeem_batch_tenant_id UNIQUE (tenant_id, batch_id);
ALTER TABLE entitlement_redeem_code
  ADD CONSTRAINT uq_redeem_code_tenant_id UNIQUE (tenant_id, code_id);

ALTER TABLE entitlement_credit_grant DROP CONSTRAINT IF EXISTS fk_entitlement_credit_grant_account;
ALTER TABLE entitlement_credit_hold DROP CONSTRAINT IF EXISTS fk_entitlement_credit_hold_account;
ALTER TABLE entitlement_usage_settlement
  DROP CONSTRAINT IF EXISTS uq_entitlement_usage_settlement_hold,
  DROP CONSTRAINT IF EXISTS uq_entitlement_usage_settlement_event,
  DROP CONSTRAINT IF EXISTS fk_entitlement_usage_settlement_hold,
  DROP CONSTRAINT IF EXISTS fk_entitlement_usage_settlement_event;
ALTER TABLE entitlement_fulfillment DROP CONSTRAINT IF EXISTS fk_entitlement_fulfillment_acquisition;
ALTER TABLE entitlement_fulfillment_reversal
  DROP CONSTRAINT IF EXISTS fk_entitlement_fulfillment_reversal_fulfillment,
  DROP CONSTRAINT IF EXISTS fk_entitlement_fulfillment_reversal_payment;
ALTER TABLE entitlement_offer_revision DROP CONSTRAINT IF EXISTS fk_entitlement_offer_revision_offer;
ALTER TABLE entitlement_usage_price_rate DROP CONSTRAINT IF EXISTS fk_entitlement_usage_price_rate_revision;
ALTER TABLE payment_customer_binding DROP CONSTRAINT IF EXISTS fk_payment_customer_binding_provider;
ALTER TABLE payment_provider_subscription DROP CONSTRAINT IF EXISTS fk_payment_provider_subscription_account;
ALTER TABLE payment_subscription_period DROP CONSTRAINT IF EXISTS fk_payment_subscription_period_subscription;
ALTER TABLE payment_settlement DROP CONSTRAINT IF EXISTS fk_payment_settlement_event;
ALTER TABLE payment_reversal DROP CONSTRAINT IF EXISTS fk_payment_reversal_settlement;
ALTER TABLE entitlement_redeem_code_batch DROP CONSTRAINT IF EXISTS fk_redeem_batch_campaign;
ALTER TABLE entitlement_redeem_code
  DROP CONSTRAINT IF EXISTS fk_redeem_code_campaign,
  DROP CONSTRAINT IF EXISTS fk_redeem_code_batch;
ALTER TABLE entitlement_redeem
  DROP CONSTRAINT IF EXISTS fk_redeem_fact_code,
  DROP CONSTRAINT IF EXISTS fk_redeem_fact_campaign;

ALTER TABLE entitlement_credit_grant
  ADD CONSTRAINT fk_entitlement_credit_grant_account_tenant
  FOREIGN KEY (tenant_id, credit_account_id) REFERENCES entitlement_credit_account (tenant_id, credit_account_id);
ALTER TABLE entitlement_credit_hold
  ADD CONSTRAINT fk_entitlement_credit_hold_account_tenant
  FOREIGN KEY (tenant_id, credit_account_id) REFERENCES entitlement_credit_account (tenant_id, credit_account_id);
ALTER TABLE entitlement_usage_settlement
  ADD CONSTRAINT uq_entitlement_usage_settlement_hold UNIQUE (tenant_id, credit_hold_id),
  ADD CONSTRAINT uq_entitlement_usage_settlement_event UNIQUE (tenant_id, usage_event_id),
  ADD CONSTRAINT fk_entitlement_usage_settlement_hold_tenant
  FOREIGN KEY (tenant_id, credit_hold_id) REFERENCES entitlement_credit_hold (tenant_id, credit_hold_id),
  ADD CONSTRAINT fk_entitlement_usage_settlement_event_tenant
  FOREIGN KEY (tenant_id, usage_event_id) REFERENCES entitlement_usage_event (tenant_id, usage_event_id);
ALTER TABLE entitlement_fulfillment
  ADD CONSTRAINT fk_entitlement_fulfillment_acquisition_tenant
  FOREIGN KEY (tenant_id, acquisition_id) REFERENCES entitlement_acquisition (tenant_id, acquisition_id);
ALTER TABLE entitlement_fulfillment_reversal
  ADD CONSTRAINT fk_entitlement_fulfillment_reversal_fulfillment_tenant
  FOREIGN KEY (tenant_id, fulfillment_id) REFERENCES entitlement_fulfillment (tenant_id, fulfillment_id),
  ADD CONSTRAINT fk_entitlement_fulfillment_reversal_payment_tenant
  FOREIGN KEY (tenant_id, payment_reversal_id) REFERENCES payment_reversal (tenant_id, reversal_id);
ALTER TABLE entitlement_offer_revision
  ADD CONSTRAINT fk_entitlement_offer_revision_offer_tenant
  FOREIGN KEY (tenant_id, offer_id) REFERENCES entitlement_offer (tenant_id, offer_id);
ALTER TABLE entitlement_usage_price_rate
  ADD CONSTRAINT fk_entitlement_usage_price_rate_revision_tenant
  FOREIGN KEY (tenant_id, usage_price_revision_id) REFERENCES entitlement_usage_price_revision (tenant_id, usage_price_revision_id);
ALTER TABLE payment_customer_binding
  ADD CONSTRAINT fk_payment_customer_binding_provider_tenant
  FOREIGN KEY (tenant_id, provider_account_id) REFERENCES payment_provider_account (tenant_id, provider_account_id);
ALTER TABLE payment_provider_subscription
  ADD CONSTRAINT fk_payment_provider_subscription_account_tenant
  FOREIGN KEY (tenant_id, provider_account_id) REFERENCES payment_provider_account (tenant_id, provider_account_id);
ALTER TABLE payment_subscription_period
  ADD CONSTRAINT fk_payment_subscription_period_subscription_tenant
  FOREIGN KEY (tenant_id, provider_subscription_id) REFERENCES payment_provider_subscription (tenant_id, provider_subscription_id);
ALTER TABLE entitlement_subscription_term
  ADD CONSTRAINT fk_entitlement_subscription_term_period_tenant
  FOREIGN KEY (tenant_id, source_period_id) REFERENCES payment_subscription_period (tenant_id, period_id);
ALTER TABLE payment_settlement
  ADD CONSTRAINT fk_payment_settlement_event_tenant
  FOREIGN KEY (tenant_id, provider_event_id) REFERENCES payment_provider_event (tenant_id, provider_event_id);
ALTER TABLE payment_reversal
  ADD CONSTRAINT fk_payment_reversal_settlement_tenant
  FOREIGN KEY (tenant_id, settlement_id) REFERENCES payment_settlement (tenant_id, settlement_id);
ALTER TABLE payment_checkout
  ADD CONSTRAINT fk_payment_checkout_offer_revision_tenant
  FOREIGN KEY (tenant_id, offer_revision_id) REFERENCES entitlement_offer_revision (tenant_id, offer_revision_id);
ALTER TABLE entitlement_redeem_code_batch
  ADD CONSTRAINT fk_redeem_batch_campaign_tenant
  FOREIGN KEY (tenant_id, campaign_id) REFERENCES entitlement_redeem_campaign (tenant_id, campaign_id);
ALTER TABLE entitlement_redeem_code
  ADD CONSTRAINT fk_redeem_code_campaign_tenant
  FOREIGN KEY (tenant_id, campaign_id) REFERENCES entitlement_redeem_campaign (tenant_id, campaign_id),
  ADD CONSTRAINT fk_redeem_code_batch_tenant
  FOREIGN KEY (tenant_id, batch_id) REFERENCES entitlement_redeem_code_batch (tenant_id, batch_id);
ALTER TABLE entitlement_redeem
  ADD CONSTRAINT fk_redeem_fact_code_tenant
  FOREIGN KEY (tenant_id, code_id) REFERENCES entitlement_redeem_code (tenant_id, code_id),
  ADD CONSTRAINT fk_redeem_fact_campaign_tenant
  FOREIGN KEY (tenant_id, campaign_id) REFERENCES entitlement_redeem_campaign (tenant_id, campaign_id),
  ADD CONSTRAINT fk_redeem_fact_grant_tenant
  FOREIGN KEY (tenant_id, credit_grant_id) REFERENCES entitlement_credit_grant (tenant_id, credit_grant_id);
