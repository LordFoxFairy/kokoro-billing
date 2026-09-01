CREATE INDEX IF NOT EXISTS ix_payment_settlement_checkout_provider
  ON payment_settlement (checkout_id, provider);
