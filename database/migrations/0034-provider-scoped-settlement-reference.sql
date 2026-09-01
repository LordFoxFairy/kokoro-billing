-- External payment references are namespaced by provider, matching the
-- settlement lookup contract and preventing Stripe/WeChat collisions.
ALTER TABLE payment_settlement
  DROP CONSTRAINT uq_payment_settlement_external;
ALTER TABLE payment_settlement
  ADD CONSTRAINT uq_payment_settlement_external
  UNIQUE (tenant_id, provider, external_payment_ref);
