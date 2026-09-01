-- A provider account is a global external identity and may belong to one
-- Billing tenant only. Keep the durable routing fact unique across tenants.
ALTER TABLE payment_provider_account
  DROP CONSTRAINT uq_payment_provider_account_external;
ALTER TABLE payment_provider_account
  ADD CONSTRAINT uq_payment_provider_account_external
  UNIQUE (provider, external_account_ref);
