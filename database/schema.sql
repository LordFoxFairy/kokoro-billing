-- PostgreSQL 16 baseline for kokoro-billing.
-- PostgreSQL owns durable Billing facts; Redis is limited to leases and idempotency hints.
-- Monetary and credit values are integer minor units; JSONB stores immutable snapshots/payloads.

CREATE TABLE IF NOT EXISTS entitlement_credit_account (
  credit_account_id VARCHAR(36) NOT NULL PRIMARY KEY,
  quota_micros BIGINT NULL,
  quota_period VARCHAR(32) NULL,
  tenant_id VARCHAR(191) NOT NULL,
  subject_id VARCHAR(255) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  available_micros BIGINT NOT NULL DEFAULT 0,
  held_micros BIGINT NOT NULL DEFAULT 0,
  generation BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT uq_entitlement_credit_account_subject UNIQUE (tenant_id, subject_id),
  CONSTRAINT ck_entitlement_credit_account_status CHECK (status IN ('active', 'disabled')),
  CONSTRAINT ck_entitlement_credit_account_balances CHECK (available_micros >= 0 AND held_micros >= 0)
);
CREATE TABLE IF NOT EXISTS entitlement_credit_grant (
  credit_grant_id VARCHAR(36) NOT NULL PRIMARY KEY,
  tenant_id VARCHAR(191) NOT NULL,
  credit_account_id VARCHAR(36) NOT NULL,
  source_kind VARCHAR(64) NOT NULL,
  source_ref VARCHAR(255) NOT NULL,
  program_key VARCHAR(255) NOT NULL,
  original_micros BIGINT NOT NULL,
  remaining_micros BIGINT NOT NULL,
  effective_at TIMESTAMPTZ(3) NOT NULL,
  expires_at TIMESTAMPTZ(3) NULL,
  burn_priority INT NOT NULL DEFAULT 0,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  issued_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  revoked_at TIMESTAMPTZ(3) NULL,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT uq_entitlement_credit_grant_source UNIQUE (tenant_id, source_kind, source_ref, program_key),
  CONSTRAINT ck_entitlement_credit_grant_status CHECK (status IN ('pending', 'active', 'exhausted', 'revoked', 'expired')),
  CONSTRAINT ck_entitlement_credit_grant_amounts CHECK (original_micros >= 0 AND remaining_micros >= 0 AND remaining_micros <= original_micros),
  CONSTRAINT ck_entitlement_credit_grant_expiry CHECK (expires_at IS NULL OR expires_at > effective_at)
);
CREATE TABLE IF NOT EXISTS entitlement_credit_hold (
  credit_hold_id VARCHAR(36) NOT NULL PRIMARY KEY,
  label_key VARCHAR(255) NULL,
  pricing_revision_id VARCHAR(36) NULL,
  tenant_id VARCHAR(191) NOT NULL,
  credit_account_id VARCHAR(36) NOT NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  requested_micros BIGINT NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  expires_at TIMESTAMPTZ(3) NOT NULL,
  captured_micros BIGINT NOT NULL DEFAULT 0,
  released_micros BIGINT NOT NULL DEFAULT 0,
  feature_key VARCHAR(255) NULL,
  model_binding_id VARCHAR(255) NULL,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT uq_entitlement_credit_hold_idempotency UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT ck_entitlement_credit_hold_status CHECK (status IN ('active', 'captured', 'released', 'expired')),
  CONSTRAINT ck_entitlement_credit_hold_amounts CHECK (requested_micros >= 0 AND captured_micros >= 0 AND released_micros >= 0 AND captured_micros + released_micros <= requested_micros)
);
CREATE TABLE IF NOT EXISTS entitlement_credit_hold_allocation (
  credit_hold_id VARCHAR(36) NOT NULL,
  tenant_id VARCHAR(191) NOT NULL,
  credit_grant_id VARCHAR(36) NOT NULL,
  held_micros BIGINT NOT NULL,
  captured_micros BIGINT NOT NULL DEFAULT 0,
  released_micros BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (credit_hold_id, credit_grant_id),
  CONSTRAINT ck_entitlement_hold_allocation_amounts CHECK (held_micros >= 0 AND captured_micros >= 0 AND released_micros >= 0 AND captured_micros + released_micros <= held_micros)
);
CREATE TABLE IF NOT EXISTS entitlement_credit_journal (
  journal_id VARCHAR(36) NOT NULL PRIMARY KEY,
  tenant_id VARCHAR(191) NOT NULL,
  credit_account_id VARCHAR(36) NOT NULL,
  journal_seq BIGINT NOT NULL,
  entry_kind VARCHAR(32) NOT NULL,
  amount_micros BIGINT NOT NULL,
  source_kind VARCHAR(64) NOT NULL,
  source_ref VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT uq_entitlement_credit_journal_sequence UNIQUE (credit_account_id, journal_seq),
  CONSTRAINT uq_entitlement_credit_journal_source UNIQUE (tenant_id, source_kind, source_ref, entry_kind),
  CONSTRAINT ck_entitlement_credit_journal_kind CHECK (entry_kind IN ('grant', 'debit', 'release', 'reversal', 'expiry', 'adjustment')),
  CONSTRAINT ck_entitlement_credit_journal_amount CHECK (amount_micros <> 0)
);
CREATE TABLE IF NOT EXISTS entitlement_usage_event (
  usage_event_id VARCHAR(36) NOT NULL PRIMARY KEY,
  tenant_id VARCHAR(191) NOT NULL,
  subject_id VARCHAR(255) NOT NULL,
  source_event_id VARCHAR(255) NOT NULL,
  feature_key VARCHAR(255) NOT NULL,
  quantity_micros BIGINT NOT NULL,
  dimensions_json JSONB NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'recorded',
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT uq_entitlement_usage_event_source UNIQUE (tenant_id, source_event_id),
  CONSTRAINT ck_entitlement_usage_event_status CHECK (status IN ('recorded', 'settled', 'failed')),
  CONSTRAINT ck_entitlement_usage_event_quantity CHECK (quantity_micros >= 0)
);
CREATE TABLE IF NOT EXISTS entitlement_usage_settlement (
  usage_settlement_id VARCHAR(36) NOT NULL PRIMARY KEY,
  tenant_id VARCHAR(191) NOT NULL,
  credit_hold_id VARCHAR(36) NOT NULL,
  usage_event_id VARCHAR(36) NOT NULL,
  actual_micros BIGINT NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'settled',
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT uq_entitlement_usage_settlement_hold UNIQUE (credit_hold_id),
  CONSTRAINT uq_entitlement_usage_settlement_event UNIQUE (usage_event_id),
  CONSTRAINT ck_entitlement_usage_settlement_status CHECK (status IN ('settled', 'unknown', 'failed')),
  CONSTRAINT ck_entitlement_usage_settlement_amount CHECK (actual_micros >= 0)
);
CREATE TABLE IF NOT EXISTS entitlement_command_receipt (
  receipt_id VARCHAR(36) NOT NULL PRIMARY KEY,
  tenant_id VARCHAR(191) NOT NULL,
  command_name VARCHAR(128) NOT NULL,
  command_identity VARCHAR(255) NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  payload_hash CHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'processing',
  result_json JSONB NULL,
  lease_until TIMESTAMPTZ(3) NULL,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT uq_entitlement_command_receipt_key UNIQUE (tenant_id, command_name, idempotency_key),
  CONSTRAINT ck_entitlement_command_receipt_status CHECK (status IN ('processing', 'succeeded', 'failed', 'unknown'))
);
CREATE TABLE IF NOT EXISTS entitlement_outbox (
  outbox_id VARCHAR(36) NOT NULL PRIMARY KEY,
  lease_token VARCHAR(36) NULL,
  lease_until TIMESTAMPTZ(3) NULL,
  dead_lettered_at TIMESTAMPTZ(3) NULL,
  tenant_id VARCHAR(191) NOT NULL,
  aggregate_type VARCHAR(64) NOT NULL,
  aggregate_id VARCHAR(36) NOT NULL,
  event_type VARCHAR(128) NOT NULL,
  payload_json JSONB NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  published_at TIMESTAMPTZ(3) NULL,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
);
CREATE TABLE IF NOT EXISTS payment_provider_event (
  provider_event_id VARCHAR(36) NOT NULL PRIMARY KEY,
  payload_hash VARCHAR(64) NOT NULL DEFAULT '',
  processing_attempts INTEGER NOT NULL DEFAULT 0,
  last_error VARCHAR(1024) NULL,
  provider_account_ref VARCHAR(255) NULL,
  tenant_id VARCHAR(191) NOT NULL,
  provider VARCHAR(64) NOT NULL,
  external_event_id VARCHAR(255) NOT NULL,
  event_type VARCHAR(128) NOT NULL,
  payload_json JSONB NOT NULL,
  signature_valid BOOLEAN NOT NULL,
  processing_status VARCHAR(32) NOT NULL DEFAULT 'received',
  received_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  processed_at TIMESTAMPTZ(3) NULL,
  CONSTRAINT uq_payment_provider_event_external UNIQUE (tenant_id, provider, external_event_id),
  CONSTRAINT ck_payment_provider_event_status CHECK (processing_status IN ('received', 'processed', 'ignored', 'failed'))
);
CREATE TABLE IF NOT EXISTS payment_settlement (
  settlement_id VARCHAR(36) NOT NULL PRIMARY KEY,
  provider VARCHAR(64) NOT NULL,
  tenant_id VARCHAR(191) NOT NULL,
  provider_event_id VARCHAR(36) NULL,
  checkout_id VARCHAR(36) NULL,
  external_payment_ref VARCHAR(255) NOT NULL,
  amount_minor BIGINT NOT NULL,
  currency CHAR(3) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'succeeded',
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT uq_payment_settlement_external UNIQUE (tenant_id, provider, external_payment_ref),
  CONSTRAINT ck_payment_settlement_status CHECK (status IN ('pending', 'succeeded', 'failed', 'unknown')),
  CONSTRAINT ck_payment_settlement_amount CHECK (amount_minor > 0),
  CONSTRAINT ck_payment_settlement_currency CHECK (currency ~ '^[A-Z]{3}$')
);
CREATE TABLE IF NOT EXISTS payment_reversal (
  reversal_id VARCHAR(36) NOT NULL PRIMARY KEY,
  provider VARCHAR(64) NOT NULL,
  tenant_id VARCHAR(191) NOT NULL,
  settlement_id VARCHAR(36) NOT NULL,
  external_reversal_ref VARCHAR(255) NOT NULL,
  amount_minor BIGINT NOT NULL,
  reason VARCHAR(255) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'succeeded',
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT uq_payment_reversal_external UNIQUE (tenant_id, provider, external_reversal_ref),
  CONSTRAINT ck_payment_reversal_status CHECK (status IN ('pending', 'succeeded', 'failed', 'unknown')),
  CONSTRAINT ck_payment_reversal_amount CHECK (amount_minor > 0)
);
CREATE TABLE IF NOT EXISTS entitlement_acquisition (
  acquisition_id VARCHAR(36) NOT NULL PRIMARY KEY,
  tenant_id VARCHAR(191) NOT NULL,
  subject_id VARCHAR(255) NOT NULL,
  source_kind VARCHAR(64) NOT NULL,
  source_ref VARCHAR(255) NOT NULL,
  program_key VARCHAR(255) NOT NULL,
  quantity_micros BIGINT NOT NULL,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT uq_entitlement_acquisition_source UNIQUE (tenant_id, source_kind, source_ref, program_key),
  CONSTRAINT ck_entitlement_acquisition_quantity CHECK (quantity_micros > 0)
);
CREATE TABLE IF NOT EXISTS entitlement_fulfillment (
  fulfillment_id VARCHAR(36) NOT NULL PRIMARY KEY,
  tenant_id VARCHAR(191) NOT NULL,
  acquisition_id VARCHAR(36) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'committed',
  committed_at TIMESTAMPTZ(3) NULL,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT uq_entitlement_fulfillment_acquisition UNIQUE (acquisition_id),
  CONSTRAINT ck_entitlement_fulfillment_status CHECK (status IN ('pending', 'committed', 'failed', 'reversed', 'reconciliation_required'))
);
CREATE TABLE IF NOT EXISTS payment_outbox (
  outbox_id VARCHAR(36) NOT NULL PRIMARY KEY,
  lease_token VARCHAR(36) NULL,
  lease_until TIMESTAMPTZ(3) NULL,
  dead_lettered_at TIMESTAMPTZ(3) NULL,
  tenant_id VARCHAR(191) NOT NULL,
  aggregate_type VARCHAR(64) NOT NULL,
  aggregate_id VARCHAR(36) NOT NULL,
  event_type VARCHAR(128) NOT NULL,
  payload_json JSONB NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  published_at TIMESTAMPTZ(3) NULL,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT uq_payment_outbox_source_event UNIQUE (aggregate_type, aggregate_id, event_type)
);
CREATE TABLE IF NOT EXISTS entitlement_fulfillment_reversal (
  fulfillment_reversal_id VARCHAR(36) NOT NULL PRIMARY KEY,
  tenant_id VARCHAR(191) NOT NULL,
  fulfillment_id VARCHAR(36) NOT NULL,
  payment_reversal_id VARCHAR(36) NOT NULL,
  amount_micros BIGINT NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'committed',
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT uq_entitlement_fulfillment_reversal_payment UNIQUE (payment_reversal_id),
  CONSTRAINT ck_entitlement_fulfillment_reversal_status CHECK (status IN ('pending', 'committed', 'reconciliation_required', 'failed')),
  CONSTRAINT ck_entitlement_fulfillment_reversal_amount CHECK (amount_micros > 0)
);
CREATE TABLE IF NOT EXISTS payment_checkout (
  checkout_id VARCHAR(36) NOT NULL PRIMARY KEY,
  provider VARCHAR(64) NULL,
  provider_account_ref VARCHAR(255) NULL,
  provider_session_id VARCHAR(255) NULL,
  checkout_url TEXT NULL,
  tenant_id VARCHAR(191) NOT NULL,
  subject_id VARCHAR(255) NOT NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  offer_revision_id VARCHAR(36) NOT NULL,
  quote_hash CHAR(64) NOT NULL,
  quote_snapshot_json JSONB NOT NULL,
  amount_minor BIGINT NOT NULL,
  currency CHAR(3) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'created',
  expires_at TIMESTAMPTZ(3) NOT NULL,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT uq_payment_checkout_idempotency UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT ck_payment_checkout_status CHECK (status IN ('created', 'pending_payment', 'paid', 'expired', 'cancelled')),
  CONSTRAINT ck_payment_checkout_amount CHECK (amount_minor > 0),
  CONSTRAINT ck_payment_checkout_currency CHECK (currency ~ '^[A-Z]{3}$')
);
CREATE TABLE IF NOT EXISTS entitlement_audit_event (
  audit_event_id VARCHAR(36) NOT NULL PRIMARY KEY,
  tenant_id VARCHAR(191) NOT NULL,
  operator_id VARCHAR(255) NOT NULL,
  action VARCHAR(128) NOT NULL,
  subject_id VARCHAR(255) NULL,
  resource_type VARCHAR(64) NOT NULL,
  resource_id VARCHAR(36) NULL,
  reason VARCHAR(500) NOT NULL,
  payload_json JSONB NOT NULL,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
);
CREATE TABLE IF NOT EXISTS entitlement_offer (
  offer_id VARCHAR(36) NOT NULL PRIMARY KEY,
  tenant_id VARCHAR(191) NOT NULL,
  offer_key VARCHAR(255) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT uq_entitlement_offer_site_key UNIQUE (tenant_id, offer_key),
  CONSTRAINT ck_entitlement_offer_status CHECK (status IN ('active', 'disabled'))
);
CREATE TABLE IF NOT EXISTS entitlement_offer_revision (
  offer_revision_id VARCHAR(36) NOT NULL PRIMARY KEY,
  offer_id VARCHAR(36) NOT NULL,
  tenant_id VARCHAR(191) NOT NULL,
  revision INTEGER NOT NULL,
  name VARCHAR(255) NOT NULL,
  currency CHAR(3) NOT NULL,
  amount_minor BIGINT NOT NULL,
  credit_micros BIGINT NOT NULL DEFAULT 0,
  billing_interval VARCHAR(16) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'published',
  metadata_json JSONB NULL,
  published_at TIMESTAMPTZ(3) NULL,
  deleted_at TIMESTAMPTZ(3) NULL,
  deleted_by VARCHAR(255) NULL,
  delete_reason VARCHAR(512) NULL,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT uq_entitlement_offer_revision_number UNIQUE (offer_id, revision),
  CONSTRAINT ck_entitlement_offer_revision_currency CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT ck_entitlement_offer_revision_amounts CHECK (amount_minor > 0 AND credit_micros >= 0),
  CONSTRAINT ck_entitlement_offer_revision_interval CHECK (billing_interval IN ('once', 'month', 'year')),
  CONSTRAINT ck_entitlement_offer_revision_status CHECK (status IN ('draft', 'published', 'disabled')),
  CONSTRAINT ck_entitlement_offer_revision_published CHECK (status <> 'published' OR published_at IS NOT NULL)
);
CREATE TABLE IF NOT EXISTS entitlement_usage_price_revision (
  usage_price_revision_id VARCHAR(36) NOT NULL PRIMARY KEY,
  tenant_id VARCHAR(191) NOT NULL,
  revision INTEGER NOT NULL,
  effective_from TIMESTAMPTZ(3) NOT NULL,
  effective_to TIMESTAMPTZ(3) NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'published',
  published_at TIMESTAMPTZ(3) NULL,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT uq_entitlement_usage_price_revision_site_number UNIQUE (tenant_id, revision),
  CONSTRAINT ck_entitlement_usage_price_revision_status CHECK (status IN ('draft', 'published', 'disabled')),
  CONSTRAINT ck_entitlement_usage_price_revision_interval CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT ck_entitlement_usage_price_revision_published CHECK (status <> 'published' OR published_at IS NOT NULL)
);
CREATE TABLE IF NOT EXISTS entitlement_usage_price_rate (
  usage_price_rate_id VARCHAR(36) NOT NULL PRIMARY KEY,
  usage_price_revision_id VARCHAR(36) NOT NULL,
  tenant_id VARCHAR(191) NOT NULL,
  feature_key VARCHAR(255) NOT NULL,
  label_key VARCHAR(255) NULL,
  model_binding_id VARCHAR(255) NULL,
  input_micros_per_million BIGINT NOT NULL DEFAULT 0,
  output_micros_per_million BIGINT NOT NULL DEFAULT 0,
  cached_micros_per_million BIGINT NOT NULL DEFAULT 0,
  reservation_micros BIGINT NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT uq_entitlement_usage_price_rate_identity UNIQUE (usage_price_revision_id, feature_key, label_key),
  CONSTRAINT ck_entitlement_usage_price_rate_status CHECK (status IN ('active', 'disabled')),
  CONSTRAINT ck_entitlement_usage_price_rate_amounts CHECK (input_micros_per_million >= 0 AND output_micros_per_million >= 0 AND cached_micros_per_million >= 0 AND reservation_micros >= 0)
);
CREATE TABLE IF NOT EXISTS payment_provider_account (
  provider_account_id VARCHAR(36) NOT NULL PRIMARY KEY,
  tenant_id VARCHAR(191) NOT NULL,
  provider VARCHAR(64) NOT NULL,
  external_account_ref VARCHAR(255) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT uq_payment_provider_account_external UNIQUE (provider, external_account_ref),
  CONSTRAINT ck_payment_provider_account_status CHECK (status IN ('active', 'disabled'))
);
CREATE TABLE IF NOT EXISTS payment_customer_binding (
  binding_id VARCHAR(36) NOT NULL PRIMARY KEY,
  tenant_id VARCHAR(191) NOT NULL,
  subject_id VARCHAR(255) NOT NULL,
  provider_account_id VARCHAR(36) NOT NULL,
  external_customer_ref VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT uq_payment_customer_binding_external UNIQUE (provider_account_id, external_customer_ref)
);
CREATE TABLE IF NOT EXISTS payment_provider_subscription (
  provider_subscription_id VARCHAR(36) NOT NULL PRIMARY KEY,
  provider VARCHAR(64) NOT NULL,
  tenant_id VARCHAR(191) NOT NULL,
  subject_id VARCHAR(255) NOT NULL,
  provider_account_id VARCHAR(36) NULL,
  external_subscription_ref VARCHAR(255) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT uq_payment_provider_subscription_external UNIQUE (tenant_id, provider, external_subscription_ref),
  CONSTRAINT ck_payment_provider_subscription_status CHECK (status IN ('active', 'canceled', 'past_due', 'unknown'))
);
CREATE TABLE IF NOT EXISTS payment_subscription_period (
  period_id VARCHAR(36) NOT NULL PRIMARY KEY,
  tenant_id VARCHAR(191) NOT NULL,
  provider_subscription_id VARCHAR(36) NOT NULL,
  period_start TIMESTAMPTZ(3) NOT NULL,
  period_end TIMESTAMPTZ(3) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT uq_payment_subscription_period_window UNIQUE (provider_subscription_id, period_start, period_end),
  CONSTRAINT ck_payment_subscription_period_window CHECK (period_end > period_start),
  CONSTRAINT ck_payment_subscription_period_status CHECK (status IN ('open', 'closed', 'failed', 'unknown'))
);
CREATE TABLE IF NOT EXISTS entitlement_subscription_term (
  term_id VARCHAR(36) NOT NULL PRIMARY KEY,
  tenant_id VARCHAR(191) NOT NULL,
  subject_id VARCHAR(255) NOT NULL,
  source_period_id VARCHAR(36) NOT NULL,
  program_key VARCHAR(255) NOT NULL,
  period_start TIMESTAMPTZ(3) NOT NULL,
  period_end TIMESTAMPTZ(3) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  grant_micros BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT uq_entitlement_subscription_term_period UNIQUE (tenant_id, source_period_id),
  CONSTRAINT ck_entitlement_subscription_term_status CHECK (status IN ('active', 'past_due', 'canceled', 'expired')),
  CONSTRAINT ck_entitlement_subscription_term_window CHECK (period_end > period_start)
);
CREATE TABLE IF NOT EXISTS payment_command_receipt (
  receipt_id VARCHAR(36) NOT NULL PRIMARY KEY,
  tenant_id VARCHAR(191) NOT NULL,
  command_name VARCHAR(128) NOT NULL,
  command_identity VARCHAR(255) NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  payload_hash CHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'processing',
  result_json JSONB NULL,
  lease_until TIMESTAMPTZ(3) NULL,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT uq_payment_command_receipt_key UNIQUE (tenant_id, command_name, idempotency_key),
  CONSTRAINT ck_payment_command_receipt_status CHECK (status IN ('processing', 'succeeded', 'failed', 'unknown'))
);
CREATE TABLE IF NOT EXISTS entitlement_redeem_campaign (
  campaign_id VARCHAR(36) NOT NULL PRIMARY KEY,
  tenant_id VARCHAR(191) NOT NULL,
  campaign_key VARCHAR(128) NOT NULL,
  program_key VARCHAR(255) NOT NULL,
  credit_micros BIGINT NOT NULL,
  max_redemptions INTEGER NOT NULL,
  redeemed_count INTEGER NOT NULL DEFAULT 0,
  starts_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  ends_at TIMESTAMPTZ(3) NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT uq_redeem_campaign_key UNIQUE (tenant_id, campaign_key),
  CONSTRAINT ck_redeem_campaign_status CHECK (status IN ('draft','active','disabled','expired')),
  CONSTRAINT ck_redeem_campaign_amount CHECK (credit_micros > 0),
  CONSTRAINT ck_redeem_campaign_limit CHECK (max_redemptions > 0)
);
CREATE TABLE IF NOT EXISTS entitlement_redeem_code_batch (
  batch_id VARCHAR(36) NOT NULL PRIMARY KEY,
  tenant_id VARCHAR(191) NOT NULL,
  campaign_id VARCHAR(36) NOT NULL,
  requested_count INTEGER NOT NULL,
  issued_count INTEGER NOT NULL DEFAULT 0,
  created_by VARCHAR(255) NOT NULL,
  reason VARCHAR(500) NOT NULL,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT ck_redeem_batch_count CHECK (requested_count > 0)
);
CREATE TABLE IF NOT EXISTS entitlement_redeem_code (
  code_id VARCHAR(36) NOT NULL PRIMARY KEY,
  tenant_id VARCHAR(191) NOT NULL,
  campaign_id VARCHAR(36) NOT NULL,
  batch_id VARCHAR(36) NOT NULL,
  code_hash CHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'issued',
  redeemed_by VARCHAR(255) NULL,
  redeemed_at TIMESTAMPTZ(3) NULL,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT uq_redeem_code_hash UNIQUE (tenant_id, code_hash),
  CONSTRAINT ck_redeem_code_status CHECK (status IN ('issued','redeemed','disabled','expired'))
);
CREATE TABLE IF NOT EXISTS entitlement_redeem (
  redemption_id VARCHAR(36) NOT NULL PRIMARY KEY,
  tenant_id VARCHAR(191) NOT NULL,
  code_id VARCHAR(36) NOT NULL,
  campaign_id VARCHAR(36) NOT NULL,
  recipient_id VARCHAR(255) NOT NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  credit_grant_id VARCHAR(36) NOT NULL,
  amount_micros BIGINT NOT NULL,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT uq_redeem_code_once UNIQUE (tenant_id, code_id),
  CONSTRAINT uq_redeem_idempotency UNIQUE (tenant_id, recipient_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS entitlement_billing_command_receipt (
  receipt_id VARCHAR(36) NOT NULL PRIMARY KEY,
  tenant_id VARCHAR(191) NOT NULL,
  api_surface VARCHAR(32) NOT NULL,
  command_name VARCHAR(128) NOT NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  payload_hash CHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'processing',
  result_json JSONB NULL,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT uq_entitlement_billing_receipt UNIQUE (tenant_id, api_surface, command_name, idempotency_key),
  CONSTRAINT ck_entitlement_billing_receipt_status CHECK (status IN ('processing', 'succeeded', 'failed', 'unknown'))
);
CREATE TABLE IF NOT EXISTS entitlement_billing_admission (
  admission_id VARCHAR(36) NOT NULL PRIMARY KEY,
  tenant_id VARCHAR(191) NOT NULL,
  billing_subject_kind VARCHAR(32) NOT NULL,
  billing_subject_ref VARCHAR(255) NOT NULL,
  payer_ref VARCHAR(255) NOT NULL,
  feature_key VARCHAR(128) NOT NULL,
  surface VARCHAR(32) NOT NULL,
  invocation_id VARCHAR(255) NOT NULL,
  execution_id VARCHAR(255) NOT NULL,
  meter_kind VARCHAR(64) NOT NULL,
  requested_model_tier VARCHAR(128) NULL,
  price_policy_revision_id VARCHAR(36) NULL,
  amount_micros BIGINT NOT NULL DEFAULT 0,
  currency CHAR(3) NOT NULL DEFAULT 'CRD',
  mode VARCHAR(32) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'created',
  hold_id VARCHAR(36) NULL,
  accepted_provider_ref VARCHAR(255) NULL,
  accepted_at TIMESTAMPTZ(3) NULL,
  service_receipt JSONB NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT uq_entitlement_admission_invocation UNIQUE (tenant_id, invocation_id),
  CONSTRAINT uq_entitlement_admission_idempotency UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT ck_entitlement_admission_mode CHECK (mode IN ('included', 'credit', 'payg', 'rejected')),
  CONSTRAINT ck_entitlement_admission_status CHECK (status IN ('created', 'held', 'captured', 'released', 'unknown', 'rejected')),
  CONSTRAINT ck_entitlement_admission_amount CHECK (amount_micros >= 0),
  CONSTRAINT ck_entitlement_admission_currency CHECK (currency ~ '^[A-Z]{3}$')
);
CREATE TABLE IF NOT EXISTS entitlement_execution_event (
  event_id VARCHAR(255) NOT NULL,
  tenant_id VARCHAR(191) NOT NULL,
  execution_id VARCHAR(255) NOT NULL,
  invocation_id VARCHAR(255) NOT NULL,
  event_type VARCHAR(64) NOT NULL,
  occurred_at TIMESTAMPTZ(3) NOT NULL,
  receipt_schema_version VARCHAR(32) NOT NULL,
  receipt_json JSONB NULL,
  payload_hash CHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'received',
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  processed_at TIMESTAMPTZ(3) NULL,
  PRIMARY KEY (tenant_id, event_id),
  CONSTRAINT ck_entitlement_execution_event_type CHECK (event_type IN ('execution.waiting', 'execution.accepted', 'execution.rejected', 'execution.failed', 'execution.unknown')),
  CONSTRAINT ck_entitlement_execution_event_status CHECK (status IN ('received', 'processed', 'failed'))
);


-- Cross-table integrity is validated by Billing application transactions and reconciliation.

-- Deliberate access paths for tenant-scoped reads, dispatch leases and reconciliation.
CREATE INDEX IF NOT EXISTS ix_entitlement_credit_grant_expiry
  ON entitlement_credit_grant (tenant_id, expires_at, burn_priority, credit_grant_id)
  WHERE status IN ('pending', 'active');
CREATE INDEX IF NOT EXISTS ix_entitlement_credit_hold_expiry
  ON entitlement_credit_hold (tenant_id, expires_at, credit_hold_id)
  WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS uq_entitlement_command_receipt_identity
  ON entitlement_command_receipt (tenant_id, command_name, command_identity)
  WHERE command_identity IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_entitlement_outbox_dispatch
  ON entitlement_outbox (next_attempt_at, created_at, outbox_id)
  WHERE published_at IS NULL AND dead_lettered_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_payment_provider_event_processing
  ON payment_provider_event (processing_status, received_at, provider_event_id)
  WHERE processing_status IN ('received', 'failed');
CREATE INDEX IF NOT EXISTS ix_payment_outbox_dispatch
  ON payment_outbox (next_attempt_at, created_at, outbox_id)
  WHERE published_at IS NULL AND dead_lettered_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_payment_settlement_checkout
  ON payment_settlement (tenant_id, checkout_id, created_at DESC, settlement_id DESC)
  WHERE checkout_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_command_receipt_identity
  ON payment_command_receipt (tenant_id, command_name, command_identity)
  WHERE command_identity IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_payment_reversal_settlement
  ON payment_reversal (tenant_id, settlement_id, created_at DESC, reversal_id DESC);
CREATE INDEX IF NOT EXISTS ix_payment_checkout_status
  ON payment_checkout (tenant_id, status, created_at DESC, checkout_id DESC);
CREATE INDEX IF NOT EXISTS ix_entitlement_subscription_term_subject
  ON entitlement_subscription_term (tenant_id, subject_id, period_start DESC, term_id DESC);
CREATE INDEX IF NOT EXISTS ix_entitlement_billing_admission_status
  ON entitlement_billing_admission (tenant_id, status, created_at DESC, admission_id DESC);
CREATE INDEX IF NOT EXISTS ix_entitlement_execution_event_processing
  ON entitlement_execution_event (tenant_id, status, occurred_at, event_id);
