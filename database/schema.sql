-- PostgreSQL 16 baseline for kokoro-billing.
-- PostgreSQL owns durable Billing facts; Redis is limited to leases and idempotency hints.
-- Monetary and credit values are integer minor units; JSONB stores immutable snapshots/payloads.

CREATE TABLE IF NOT EXISTS billing_credit_account (
  id UUID NOT NULL PRIMARY KEY,
  tenant_id VARCHAR(191) NOT NULL,
  subject_id VARCHAR(255) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  available_micros BIGINT NOT NULL DEFAULT 0,
  held_micros BIGINT NOT NULL DEFAULT 0,
  generation BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT uq_billing_credit_account_subject UNIQUE (tenant_id, subject_id),
  CONSTRAINT ck_billing_credit_account_status CHECK (status IN ('active', 'disabled')),
  CONSTRAINT ck_billing_credit_account_balances CHECK (available_micros >= 0 AND held_micros >= 0)
);
CREATE TABLE IF NOT EXISTS billing_credit_grant (
  id UUID NOT NULL PRIMARY KEY,
  tenant_id VARCHAR(191) NOT NULL,
  credit_account_id UUID NOT NULL,
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
  CONSTRAINT uq_billing_credit_grant_source UNIQUE (tenant_id, source_kind, source_ref, program_key),
  CONSTRAINT ck_billing_credit_grant_status CHECK (status IN ('pending', 'active', 'exhausted', 'revoked', 'expired')),
  CONSTRAINT ck_billing_credit_grant_amounts CHECK (original_micros >= 0 AND remaining_micros >= 0 AND remaining_micros <= original_micros),
  CONSTRAINT ck_billing_credit_grant_expiry CHECK (expires_at IS NULL OR expires_at > effective_at)
);
CREATE TABLE IF NOT EXISTS billing_credit_hold (
  id UUID NOT NULL PRIMARY KEY,
  tenant_id VARCHAR(191) NOT NULL,
  credit_account_id UUID NOT NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  requested_micros BIGINT NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  expires_at TIMESTAMPTZ(3) NOT NULL,
  captured_micros BIGINT NOT NULL DEFAULT 0,
  released_micros BIGINT NOT NULL DEFAULT 0,
  feature_key VARCHAR(255) NULL,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT uq_billing_credit_hold_idempotency UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT ck_billing_credit_hold_status CHECK (status IN ('active', 'captured', 'released', 'expired')),
  CONSTRAINT ck_billing_credit_hold_amounts CHECK (requested_micros >= 0 AND captured_micros >= 0 AND released_micros >= 0 AND captured_micros + released_micros <= requested_micros)
);
CREATE TABLE IF NOT EXISTS billing_credit_hold_allocation (
  id UUID NOT NULL PRIMARY KEY,
  credit_hold_id UUID NOT NULL,
  tenant_id VARCHAR(191) NOT NULL,
  credit_grant_id UUID NOT NULL,
  held_micros BIGINT NOT NULL,
  captured_micros BIGINT NOT NULL DEFAULT 0,
  released_micros BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT uq_billing_hold_allocation_pair UNIQUE (credit_hold_id, credit_grant_id),
  CONSTRAINT ck_billing_hold_allocation_amounts CHECK (held_micros >= 0 AND captured_micros >= 0 AND released_micros >= 0 AND captured_micros + released_micros <= held_micros)
);
CREATE TABLE IF NOT EXISTS billing_credit_journal (
  id UUID NOT NULL PRIMARY KEY,
  tenant_id VARCHAR(191) NOT NULL,
  credit_account_id UUID NOT NULL,
  journal_seq BIGINT NOT NULL,
  entry_kind VARCHAR(32) NOT NULL,
  amount_micros BIGINT NOT NULL,
  source_kind VARCHAR(64) NOT NULL,
  source_ref VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT uq_billing_credit_journal_sequence UNIQUE (credit_account_id, journal_seq),
  CONSTRAINT uq_billing_credit_journal_source UNIQUE (tenant_id, source_kind, source_ref, entry_kind),
  CONSTRAINT ck_billing_credit_journal_kind CHECK (entry_kind IN ('grant', 'debit', 'release', 'reversal', 'expiry', 'adjustment')),
  CONSTRAINT ck_billing_credit_journal_amount CHECK (amount_micros <> 0)
);
CREATE TABLE IF NOT EXISTS billing_usage_event (
  id UUID NOT NULL PRIMARY KEY,
  credit_hold_id UUID NULL,
  tenant_id VARCHAR(191) NOT NULL,
  subject_id VARCHAR(255) NOT NULL,
  source_event_id VARCHAR(255) NOT NULL,
  feature_key VARCHAR(255) NOT NULL,
  quantity BIGINT NOT NULL,
  dimensions_json JSONB NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'recorded',
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT uq_billing_usage_event_source UNIQUE (tenant_id, source_event_id),
  CONSTRAINT uq_billing_usage_event_hold UNIQUE (credit_hold_id),
  CONSTRAINT ck_billing_usage_event_status CHECK (status IN ('recorded', 'settled', 'failed')),
  CONSTRAINT ck_billing_usage_event_quantity CHECK (quantity >= 0)
);
CREATE TABLE IF NOT EXISTS billing_usage_settlement (
  id UUID NOT NULL PRIMARY KEY,
  tenant_id VARCHAR(191) NOT NULL,
  credit_hold_id UUID NOT NULL,
  usage_event_id UUID NOT NULL,
  actual_micros BIGINT NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'settled',
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT uq_billing_usage_settlement_hold UNIQUE (credit_hold_id),
  CONSTRAINT uq_billing_usage_settlement_event UNIQUE (usage_event_id),
  CONSTRAINT ck_billing_usage_settlement_status CHECK (status IN ('settled', 'unknown', 'failed')),
  CONSTRAINT ck_billing_usage_settlement_amount CHECK (actual_micros >= 0)
);
CREATE TABLE IF NOT EXISTS billing_command_receipt (
  id UUID NOT NULL PRIMARY KEY,
  tenant_id VARCHAR(191) NOT NULL,
  command_namespace VARCHAR(16) NOT NULL,
  api_surface VARCHAR(32) NOT NULL,
  command_name VARCHAR(128) NOT NULL,
  command_identity VARCHAR(255) NULL,
  request_schema_version INTEGER NOT NULL,
  payload_digest CHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'processing',
  result_schema_version INTEGER NULL,
  result_json JSONB NULL,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT ck_billing_command_receipt_namespace CHECK (command_namespace IN ('general', 'payment', 'admission')),
  CONSTRAINT ck_billing_command_receipt_surface CHECK (api_surface = 'internal'),
  CONSTRAINT ck_billing_command_receipt_versions CHECK (request_schema_version > 0 AND (result_schema_version IS NULL OR result_schema_version > 0)),
  CONSTRAINT ck_billing_command_receipt_digest CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ck_billing_command_receipt_status CHECK (status IN ('processing', 'succeeded', 'failed', 'unknown')),
  CONSTRAINT ck_billing_command_receipt_result CHECK ((status = 'succeeded' AND result_schema_version IS NOT NULL AND result_json IS NOT NULL) OR (status <> 'succeeded' AND result_schema_version IS NULL AND result_json IS NULL))
);
CREATE TABLE IF NOT EXISTS billing_command_key_binding (
  id UUID NOT NULL PRIMARY KEY,
  tenant_id VARCHAR(191) NOT NULL,
  command_namespace VARCHAR(16) NOT NULL,
  api_surface VARCHAR(32) NOT NULL,
  command_name VARCHAR(128) NOT NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  command_receipt_id UUID NOT NULL,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT uq_billing_command_key_binding_scope UNIQUE (tenant_id, command_namespace, api_surface, command_name, idempotency_key),
  CONSTRAINT ck_billing_command_key_binding_namespace CHECK (command_namespace IN ('general', 'payment', 'admission')),
  CONSTRAINT ck_billing_command_key_binding_surface CHECK (api_surface = 'internal'),
  CONSTRAINT ck_billing_command_key_binding_key CHECK (idempotency_key <> '')
);
CREATE TABLE IF NOT EXISTS billing_outbox (
  id UUID NOT NULL PRIMARY KEY,
  tenant_id VARCHAR(191) NOT NULL,
  event_namespace VARCHAR(16) NOT NULL,
  aggregate_type VARCHAR(64) NOT NULL,
  aggregate_id UUID NOT NULL,
  event_type VARCHAR(128) NOT NULL,
  event_identity VARCHAR(255) NOT NULL,
  payload_schema_version INTEGER NOT NULL,
  payload_digest CHAR(64) NOT NULL,
  payload_json JSONB NOT NULL,
  lease_token UUID NULL,
  lease_until TIMESTAMPTZ(3) NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  completed_at TIMESTAMPTZ(3) NULL,
  dead_lettered_at TIMESTAMPTZ(3) NULL,
  last_error_code VARCHAR(128) NULL,
  requeue_generation INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT uq_billing_outbox_identity UNIQUE (event_namespace, event_identity),
  CONSTRAINT ck_billing_outbox_namespace CHECK (event_namespace IN ('credit', 'payment')),
  CONSTRAINT ck_billing_outbox_versions CHECK (payload_schema_version > 0 AND requeue_generation >= 0),
  CONSTRAINT ck_billing_outbox_digest CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ck_billing_outbox_attempts CHECK (attempts >= 0),
  CONSTRAINT ck_billing_outbox_lease CHECK ((lease_token IS NULL) = (lease_until IS NULL)),
  CONSTRAINT ck_billing_outbox_terminal CHECK (NOT (completed_at IS NOT NULL AND dead_lettered_at IS NOT NULL) AND ((completed_at IS NULL AND dead_lettered_at IS NULL) OR lease_token IS NULL)),
  CONSTRAINT ck_billing_outbox_completed_error CHECK (completed_at IS NULL OR last_error_code IS NULL)
);
CREATE TABLE IF NOT EXISTS billing_provider_event (
  id UUID NOT NULL PRIMARY KEY,
  payload_hash VARCHAR(64) NOT NULL DEFAULT '',
  processing_attempts INTEGER NOT NULL DEFAULT 0,
  processing_token UUID NULL,
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
  CONSTRAINT uq_billing_provider_event_external UNIQUE (tenant_id, provider, external_event_id),
  CONSTRAINT ck_billing_provider_event_status CHECK (processing_status IN ('received', 'processed', 'ignored', 'failed')),
  CONSTRAINT ck_billing_provider_event_attempts CHECK (processing_attempts >= 0)
);
CREATE TABLE IF NOT EXISTS billing_payment_settlement (
  id UUID NOT NULL PRIMARY KEY,
  provider VARCHAR(64) NOT NULL,
  provider_account_id UUID NOT NULL,
  tenant_id VARCHAR(191) NOT NULL,
  provider_event_id UUID NULL,
  checkout_id UUID NULL,
  external_payment_ref VARCHAR(255) NOT NULL,
  external_charge_ref VARCHAR(255) NULL,
  external_payment_intent_ref VARCHAR(255) NULL,
  amount_minor BIGINT NOT NULL,
  currency_code CHAR(3) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'succeeded',
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT uq_billing_settlement_external UNIQUE (tenant_id, provider, external_payment_ref),
  CONSTRAINT uq_billing_settlement_charge UNIQUE (provider_account_id, external_charge_ref),
  CONSTRAINT ck_billing_settlement_status CHECK (status IN ('pending', 'succeeded', 'failed', 'unknown')),
  CONSTRAINT ck_billing_settlement_amount CHECK (amount_minor > 0),
  CONSTRAINT ck_billing_settlement_currency CHECK (currency_code ~ '^[A-Z]{3}$')
);
CREATE TABLE IF NOT EXISTS billing_payment_reversal (
  id UUID NOT NULL PRIMARY KEY,
  provider VARCHAR(64) NOT NULL,
  provider_account_id UUID NOT NULL,
  tenant_id VARCHAR(191) NOT NULL,
  settlement_id UUID NOT NULL,
  external_reversal_ref VARCHAR(255) NOT NULL,
  amount_minor BIGINT NOT NULL,
  currency_code CHAR(3) NOT NULL,
  reason VARCHAR(255) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'succeeded',
  observed_provider_event_id UUID NULL,
  observed_at TIMESTAMPTZ(3) NULL,
  credit_effect_status VARCHAR(32) NOT NULL DEFAULT 'waiting_provider',
  credit_effect_completed_at TIMESTAMPTZ(3) NULL,
  credit_effect_error_code VARCHAR(128) NULL,
  review_reason_code VARCHAR(128) NULL,
  credit_fulfillment_id UUID NULL,
  credit_grant_id UUID NULL,
  allocation_policy_version VARCHAR(32) NULL,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT uq_billing_reversal_external UNIQUE (provider_account_id, external_reversal_ref),
  CONSTRAINT ck_billing_reversal_status CHECK (status IN ('unknown', 'pending', 'requires_action', 'succeeded', 'failed', 'canceled')),
  CONSTRAINT ck_billing_reversal_effect CHECK (credit_effect_status IN ('waiting_provider', 'pending', 'applied', 'review_required', 'not_applicable')),
  CONSTRAINT ck_billing_reversal_applied CHECK (credit_effect_status <> 'applied' OR (credit_effect_completed_at IS NOT NULL AND credit_fulfillment_id IS NOT NULL AND credit_grant_id IS NOT NULL AND allocation_policy_version IS NOT NULL)),
  CONSTRAINT ck_billing_reversal_amount CHECK (amount_minor > 0)
);
CREATE TABLE IF NOT EXISTS billing_credit_fulfillment (
  id UUID NOT NULL PRIMARY KEY,
  tenant_id VARCHAR(191) NOT NULL,
  subject_id VARCHAR(255) NOT NULL,
  credit_account_id UUID NOT NULL,
  source_kind VARCHAR(64) NOT NULL,
  source_ref VARCHAR(255) NOT NULL,
  program_key VARCHAR(255) NOT NULL,
  authorized_micros BIGINT NOT NULL,
  effective_at TIMESTAMPTZ(3) NOT NULL,
  expires_at TIMESTAMPTZ(3) NULL,
  authorization_policy_version INTEGER NOT NULL,
  authorization_digest CHAR(64) NOT NULL,
  credit_grant_id UUID NOT NULL,
  grant_journal_id UUID NOT NULL,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  committed_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT uq_billing_credit_fulfillment_source UNIQUE (tenant_id, source_kind, source_ref),
  CONSTRAINT uq_billing_credit_fulfillment_grant UNIQUE (credit_grant_id),
  CONSTRAINT uq_billing_credit_fulfillment_journal UNIQUE (grant_journal_id),
  CONSTRAINT ck_billing_credit_fulfillment_source CHECK (source_kind IN ('payment_settlement', 'subscription_period')),
  CONSTRAINT ck_billing_credit_fulfillment_amount CHECK (authorized_micros > 0),
  CONSTRAINT ck_billing_credit_fulfillment_policy CHECK (authorization_policy_version > 0),
  CONSTRAINT ck_billing_credit_fulfillment_digest CHECK (authorization_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ck_billing_credit_fulfillment_window CHECK (expires_at IS NULL OR expires_at > effective_at),
  CONSTRAINT ck_billing_credit_fulfillment_commit CHECK (committed_at >= created_at)
);
CREATE TABLE IF NOT EXISTS billing_credit_fulfillment_reversal (
  id UUID NOT NULL PRIMARY KEY,
  tenant_id VARCHAR(191) NOT NULL,
  fulfillment_id UUID NOT NULL,
  payment_reversal_id UUID NOT NULL,
  amount_micros BIGINT NOT NULL,
  journal_id UUID NULL,
  policy_version INTEGER NOT NULL,
  input_digest CHAR(64) NOT NULL,
  refund_amount_minor BIGINT NOT NULL,
  prior_refund_amount_minor BIGINT NOT NULL,
  prior_credit_micros BIGINT NOT NULL,
  settlement_amount_minor BIGINT NOT NULL,
  fulfillment_authorized_micros BIGINT NOT NULL,
  grant_original_micros BIGINT NOT NULL,
  grant_remaining_micros_before BIGINT NOT NULL,
  grant_status_before VARCHAR(32) NOT NULL,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT uq_billing_fulfillment_reversal_payment UNIQUE (payment_reversal_id),
  CONSTRAINT ck_billing_fulfillment_reversal_amount CHECK (amount_micros >= 0),
  CONSTRAINT ck_billing_fulfillment_reversal_journal CHECK ((amount_micros = 0) = (journal_id IS NULL)),
  CONSTRAINT ck_billing_fulfillment_reversal_policy CHECK (policy_version > 0 AND refund_amount_minor > 0 AND prior_refund_amount_minor >= 0 AND prior_credit_micros >= 0 AND settlement_amount_minor > 0 AND fulfillment_authorized_micros > 0 AND grant_original_micros > 0 AND grant_remaining_micros_before >= 0),
  CONSTRAINT ck_billing_fulfillment_reversal_digest CHECK (input_digest ~ '^[0-9a-f]{64}$')
);
CREATE TABLE IF NOT EXISTS billing_checkout (
  id UUID NOT NULL PRIMARY KEY,
  provider VARCHAR(64) NOT NULL,
  provider_account_id UUID NOT NULL,
  provider_account_ref VARCHAR(255) NOT NULL,
  provider_environment VARCHAR(8) NOT NULL,
  checkout_session_mode VARCHAR(16) NOT NULL,
  provider_idempotency_key VARCHAR(255) NOT NULL,
  provider_request_json JSONB NOT NULL,
  provider_request_digest CHAR(64) NOT NULL,
  provider_session_id VARCHAR(255) NULL,
  checkout_url TEXT NULL,
  tenant_id VARCHAR(191) NOT NULL,
  subject_id VARCHAR(255) NOT NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  offer_revision_id UUID NOT NULL,
  quote_hash CHAR(64) NOT NULL,
  quote_snapshot_json JSONB NOT NULL,
  amount_minor BIGINT NOT NULL,
  currency_code CHAR(3) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'created',
  quote_expires_at TIMESTAMPTZ(3) NOT NULL,
  provider_session_expires_at TIMESTAMPTZ(3) NULL,
  session_creation_status VARCHAR(32) NOT NULL DEFAULT 'not_started',
  session_attempts INTEGER NOT NULL DEFAULT 0,
  session_attempt_token UUID NULL,
  session_lease_until TIMESTAMPTZ(3) NULL,
  first_attempt_at TIMESTAMPTZ(3) NULL,
  retry_deadline_at TIMESTAMPTZ(3) NULL,
  next_attempt_at TIMESTAMPTZ(3) NULL,
  session_had_unknown BOOLEAN NOT NULL DEFAULT false,
  session_last_error_code VARCHAR(128) NULL,
  provider_request_id VARCHAR(255) NULL,
  provider_session_status VARCHAR(16) NULL,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT uq_billing_checkout_idempotency UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT uq_billing_checkout_provider_key UNIQUE (provider_account_id, provider_idempotency_key),
  CONSTRAINT uq_billing_checkout_provider_session UNIQUE (provider_account_id, provider_session_id),
  CONSTRAINT ck_billing_checkout_status CHECK (status IN ('created', 'pending_payment', 'paid', 'expired', 'cancelled')),
  CONSTRAINT ck_billing_checkout_amount CHECK (amount_minor > 0),
  CONSTRAINT ck_billing_checkout_currency CHECK (currency_code ~ '^[A-Z]{3}$')
  ,CONSTRAINT ck_billing_checkout_environment CHECK (provider_environment IN ('test', 'live'))
  ,CONSTRAINT ck_billing_checkout_mode CHECK (checkout_session_mode IN ('payment', 'subscription'))
  ,CONSTRAINT ck_billing_checkout_request CHECK (provider_idempotency_key <> '' AND provider_request_digest ~ '^[0-9a-f]{64}$' AND jsonb_typeof(provider_request_json) = 'object')
  ,CONSTRAINT ck_billing_checkout_session_state CHECK (session_creation_status IN ('not_started', 'in_flight', 'unknown', 'ready', 'failed', 'review_required'))
  ,CONSTRAINT ck_billing_checkout_attempts CHECK (session_attempts >= 0)
  ,CONSTRAINT ck_billing_checkout_lease CHECK ((session_creation_status = 'in_flight' AND session_attempt_token IS NOT NULL AND session_lease_until IS NOT NULL AND first_attempt_at IS NOT NULL AND retry_deadline_at IS NOT NULL) OR (session_creation_status <> 'in_flight' AND session_lease_until IS NULL))
  ,CONSTRAINT ck_billing_checkout_deadline CHECK (retry_deadline_at IS NULL OR first_attempt_at IS NOT NULL AND retry_deadline_at > first_attempt_at)
  ,CONSTRAINT ck_billing_checkout_provider_status CHECK (provider_session_status IS NULL OR provider_session_status IN ('open', 'complete', 'expired'))
  ,CONSTRAINT ck_billing_checkout_ready CHECK (session_creation_status <> 'ready' OR (provider_session_id IS NOT NULL AND provider_session_status IS NOT NULL))
  ,CONSTRAINT ck_billing_checkout_retry CHECK ((session_creation_status NOT IN ('ready', 'failed', 'review_required')) OR next_attempt_at IS NULL)
  ,CONSTRAINT ck_billing_checkout_unknown CHECK (session_creation_status <> 'unknown' OR (session_attempts > 0 AND first_attempt_at IS NOT NULL AND retry_deadline_at IS NOT NULL AND next_attempt_at IS NOT NULL))
  ,CONSTRAINT ck_billing_checkout_initial CHECK (session_creation_status <> 'not_started' OR (session_attempts = 0 AND session_attempt_token IS NULL AND first_attempt_at IS NULL AND retry_deadline_at IS NULL))
  ,CONSTRAINT ck_billing_checkout_failed_history CHECK (session_creation_status <> 'failed' OR session_had_unknown = false)
);
CREATE TABLE IF NOT EXISTS billing_audit_event (
  id UUID NOT NULL PRIMARY KEY,
  tenant_id VARCHAR(191) NOT NULL,
  operator_id VARCHAR(255) NOT NULL,
  action VARCHAR(128) NOT NULL,
  subject_id VARCHAR(255) NULL,
  resource_type VARCHAR(64) NOT NULL,
  resource_id UUID NULL,
  reason VARCHAR(500) NOT NULL,
  payload_json JSONB NOT NULL,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
);
CREATE TABLE IF NOT EXISTS billing_offer (
  id UUID NOT NULL PRIMARY KEY,
  tenant_id VARCHAR(191) NOT NULL,
  offer_key VARCHAR(255) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT uq_billing_offer_site_key UNIQUE (tenant_id, offer_key),
  CONSTRAINT ck_billing_offer_status CHECK (status IN ('active', 'disabled'))
);
CREATE TABLE IF NOT EXISTS billing_offer_revision (
  id UUID NOT NULL PRIMARY KEY,
  offer_id UUID NOT NULL,
  tenant_id VARCHAR(191) NOT NULL,
  revision INTEGER NOT NULL,
  name VARCHAR(255) NOT NULL,
  currency_code CHAR(3) NOT NULL,
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
  CONSTRAINT uq_billing_offer_revision_number UNIQUE (offer_id, revision),
  CONSTRAINT ck_billing_offer_revision_currency CHECK (currency_code ~ '^[A-Z]{3}$'),
  CONSTRAINT ck_billing_offer_revision_amounts CHECK (amount_minor > 0 AND credit_micros >= 0),
  CONSTRAINT ck_billing_offer_revision_interval CHECK (billing_interval IN ('once', 'month', 'year')),
  CONSTRAINT ck_billing_offer_revision_status CHECK (status IN ('draft', 'published', 'disabled')),
  CONSTRAINT ck_billing_offer_revision_published CHECK (status <> 'published' OR published_at IS NOT NULL)
);
CREATE TABLE IF NOT EXISTS billing_feature_price_revision (
  id UUID NOT NULL PRIMARY KEY,
  tenant_id VARCHAR(191) NOT NULL,
  revision INTEGER NOT NULL,
  effective_from TIMESTAMPTZ(3) NOT NULL,
  published_at TIMESTAMPTZ(3) NOT NULL,
  created_by VARCHAR(255) NOT NULL,
  audit_event_id UUID NOT NULL,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT uq_billing_feature_price_revision_number UNIQUE (tenant_id, revision),
  CONSTRAINT ck_billing_feature_price_revision_number CHECK (revision > 0)
);
CREATE TABLE IF NOT EXISTS billing_feature_price (
  id UUID NOT NULL PRIMARY KEY,
  feature_price_revision_id UUID NOT NULL,
  tenant_id VARCHAR(191) NOT NULL,
  feature_key VARCHAR(255) NOT NULL,
  unit_price_micros BIGINT NOT NULL,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT uq_billing_feature_price_identity UNIQUE (feature_price_revision_id, feature_key),
  CONSTRAINT ck_billing_feature_price_amount CHECK (unit_price_micros >= 0)
);
CREATE TABLE IF NOT EXISTS billing_provider_account (
  id UUID NOT NULL PRIMARY KEY,
  tenant_id VARCHAR(191) NOT NULL,
  provider VARCHAR(64) NOT NULL,
  provider_environment VARCHAR(8) NOT NULL,
  external_account_ref VARCHAR(255) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT uq_billing_provider_account_external UNIQUE (provider, provider_environment, external_account_ref),
  CONSTRAINT ck_billing_provider_account_environment CHECK (provider_environment IN ('test', 'live')),
  CONSTRAINT ck_billing_provider_account_status CHECK (status IN ('active', 'disabled'))
);
CREATE TABLE IF NOT EXISTS billing_customer_binding (
  id UUID NOT NULL PRIMARY KEY,
  tenant_id VARCHAR(191) NOT NULL,
  subject_id VARCHAR(255) NOT NULL,
  provider_account_id UUID NOT NULL,
  external_customer_ref VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT uq_billing_customer_binding_external UNIQUE (provider_account_id, external_customer_ref)
);
CREATE TABLE IF NOT EXISTS billing_provider_subscription (
  id UUID NOT NULL PRIMARY KEY,
  provider VARCHAR(64) NOT NULL,
  tenant_id VARCHAR(191) NOT NULL,
  subject_id VARCHAR(255) NOT NULL,
  provider_account_id UUID NOT NULL,
  checkout_id UUID NOT NULL,
  offer_revision_id UUID NOT NULL,
  external_subscription_ref VARCHAR(255) NOT NULL,
  subscription_item_ref VARCHAR(255) NOT NULL,
  provider_price_ref VARCHAR(255) NOT NULL,
  program_key VARCHAR(255) NOT NULL,
  authorized_micros BIGINT NOT NULL,
  currency_code CHAR(3) NOT NULL,
  billing_interval VARCHAR(16) NOT NULL,
  authorization_policy_version INTEGER NOT NULL,
  authorization_digest CHAR(64) NOT NULL,
  provider_status VARCHAR(32) NOT NULL,
  last_observation_event_id UUID NOT NULL,
  observed_at TIMESTAMPTZ(3) NOT NULL,
  review_reason_code VARCHAR(128) NULL,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT uq_billing_provider_subscription_external UNIQUE (provider_account_id, external_subscription_ref),
  CONSTRAINT ck_billing_provider_subscription_status CHECK (provider_status IN ('incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused', 'unknown')),
  CONSTRAINT ck_billing_provider_subscription_quote CHECK (authorized_micros >= 0 AND currency_code ~ '^[A-Z]{3}$' AND billing_interval IN ('month', 'year') AND authorization_policy_version > 0),
  CONSTRAINT ck_billing_provider_subscription_digest CHECK (authorization_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ck_billing_provider_subscription_observation CHECK (observed_at >= created_at)
);
CREATE TABLE IF NOT EXISTS billing_subscription_period (
  id UUID NOT NULL PRIMARY KEY,
  tenant_id VARCHAR(191) NOT NULL,
  provider_subscription_id UUID NOT NULL,
  provider_account_id UUID NOT NULL,
  subscription_item_ref VARCHAR(255) NOT NULL,
  external_invoice_ref VARCHAR(255) NOT NULL,
  external_invoice_line_ref VARCHAR(255) NOT NULL,
  program_key VARCHAR(255) NOT NULL,
  authorized_micros BIGINT NOT NULL,
  authorization_policy_version INTEGER NOT NULL,
  authorization_digest CHAR(64) NOT NULL,
  period_start TIMESTAMPTZ(3) NOT NULL,
  period_end TIMESTAMPTZ(3) NOT NULL,
  invoice_status VARCHAR(32) NOT NULL,
  settlement_evidence_kind VARCHAR(32) NOT NULL,
  source_event_id UUID NOT NULL,
  evidence_schema_version INTEGER NOT NULL,
  evidence_digest CHAR(64) NOT NULL,
  evidence_json JSONB NOT NULL,
  payment_settlement_id UUID NULL,
  grant_status VARCHAR(32) NOT NULL DEFAULT 'waiting_evidence',
  grant_error_code VARCHAR(128) NULL,
  grant_completed_at TIMESTAMPTZ(3) NULL,
  credit_fulfillment_id UUID NULL,
  next_evidence_check_at TIMESTAMPTZ(3) NULL,
  evidence_check_attempts INTEGER NOT NULL DEFAULT 0,
  evidence_check_started_at TIMESTAMPTZ(3) NULL,
  evidence_check_deadline_at TIMESTAMPTZ(3) NULL,
  evidence_generation INTEGER NOT NULL DEFAULT 0,
  last_evidence_check_error_code VARCHAR(128) NULL,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT uq_billing_subscription_period_invoice UNIQUE (provider_account_id, external_invoice_ref, external_invoice_line_ref),
  CONSTRAINT uq_billing_subscription_period_window UNIQUE (provider_subscription_id, subscription_item_ref, period_start, period_end, program_key),
  CONSTRAINT ck_billing_subscription_period_window CHECK (period_end > period_start),
  CONSTRAINT ck_billing_subscription_period_grant CHECK (grant_status IN ('waiting_evidence', 'waiting_period_start', 'pending', 'applied', 'review_required')),
  CONSTRAINT ck_billing_subscription_period_attempts CHECK (evidence_check_attempts >= 0 AND evidence_generation >= 0),
  CONSTRAINT ck_billing_subscription_period_authorization CHECK (authorized_micros >= 0 AND authorization_policy_version > 0 AND authorization_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ck_billing_subscription_period_digest CHECK (evidence_schema_version > 0 AND evidence_digest ~ '^[0-9a-f]{64}$' AND jsonb_typeof(evidence_json) = 'object'),
  CONSTRAINT ck_billing_subscription_period_applied CHECK (grant_status <> 'applied' OR (grant_completed_at IS NOT NULL AND credit_fulfillment_id IS NOT NULL)),
  CONSTRAINT ck_billing_subscription_period_evidence_window CHECK (evidence_check_deadline_at IS NULL OR (evidence_check_started_at IS NOT NULL AND evidence_check_deadline_at > evidence_check_started_at))
);
CREATE TABLE IF NOT EXISTS billing_subscription_term (
  id UUID NOT NULL PRIMARY KEY,
  tenant_id VARCHAR(191) NOT NULL,
  subject_id VARCHAR(255) NOT NULL,
  source_period_id UUID NOT NULL,
  program_key VARCHAR(255) NOT NULL,
  period_start TIMESTAMPTZ(3) NOT NULL,
  period_end TIMESTAMPTZ(3) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  grant_micros BIGINT NOT NULL DEFAULT 0,
  credit_fulfillment_id UUID NULL,
  authorization_digest CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT uq_billing_subscription_term_period UNIQUE (tenant_id, source_period_id),
  CONSTRAINT ck_billing_subscription_term_status CHECK (status IN ('active', 'past_due', 'canceled', 'expired')),
  CONSTRAINT ck_billing_subscription_term_window CHECK (period_end > period_start),
  CONSTRAINT ck_billing_subscription_term_grant CHECK (grant_micros >= 0 AND authorization_digest ~ '^[0-9a-f]{64}$')
);
CREATE TABLE IF NOT EXISTS billing_redeem_campaign (
  id UUID NOT NULL PRIMARY KEY,
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
  CONSTRAINT uq_billing_redeem_campaign_key UNIQUE (tenant_id, campaign_key),
  CONSTRAINT ck_billing_redeem_campaign_status CHECK (status IN ('draft','active','disabled','expired')),
  CONSTRAINT ck_billing_redeem_campaign_amount CHECK (credit_micros > 0),
  CONSTRAINT ck_billing_redeem_campaign_limit CHECK (max_redemptions > 0)
);
CREATE TABLE IF NOT EXISTS billing_redeem_code_batch (
  id UUID NOT NULL PRIMARY KEY,
  tenant_id VARCHAR(191) NOT NULL,
  campaign_id UUID NOT NULL,
  requested_count INTEGER NOT NULL,
  issued_count INTEGER NOT NULL DEFAULT 0,
  created_by VARCHAR(255) NOT NULL,
  reason VARCHAR(500) NOT NULL,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT ck_billing_redeem_batch_count CHECK (requested_count > 0)
);
CREATE TABLE IF NOT EXISTS billing_redeem_code (
  id UUID NOT NULL PRIMARY KEY,
  tenant_id VARCHAR(191) NOT NULL,
  campaign_id UUID NOT NULL,
  batch_id UUID NOT NULL,
  code_hash CHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'issued',
  redeemed_by VARCHAR(255) NULL,
  redeemed_at TIMESTAMPTZ(3) NULL,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT uq_billing_redeem_code_hash UNIQUE (tenant_id, code_hash),
  CONSTRAINT ck_billing_redeem_code_status CHECK (status IN ('issued','redeemed','disabled','expired'))
);
CREATE TABLE IF NOT EXISTS billing_redeem (
  id UUID NOT NULL PRIMARY KEY,
  tenant_id VARCHAR(191) NOT NULL,
  code_id UUID NOT NULL,
  campaign_id UUID NOT NULL,
  recipient_id VARCHAR(255) NOT NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  credit_grant_id UUID NOT NULL,
  amount_micros BIGINT NOT NULL,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT uq_billing_redeem_code_once UNIQUE (tenant_id, code_id),
  CONSTRAINT uq_billing_redeem_idempotency UNIQUE (tenant_id, recipient_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS billing_admission (
  id UUID NOT NULL PRIMARY KEY,
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
  pricing_revision_id UUID NOT NULL,
  feature_price_id UUID NOT NULL,
  authorized_micros BIGINT NOT NULL,
  pricing_snapshot_digest CHAR(64) NOT NULL,
  quantity BIGINT NOT NULL DEFAULT 1,
  mode VARCHAR(32) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'created',
  hold_id UUID NULL,
  accepted_provider_ref VARCHAR(255) NULL,
  accepted_at TIMESTAMPTZ(3) NULL,
  service_receipt JSONB NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT uq_billing_admission_invocation UNIQUE (tenant_id, invocation_id),
  CONSTRAINT uq_billing_admission_idempotency UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT ck_billing_admission_mode CHECK (mode IN ('included', 'credit', 'rejected')),
  CONSTRAINT ck_billing_admission_status CHECK (status IN ('created', 'held', 'captured', 'released', 'unknown', 'rejected')),
  CONSTRAINT ck_billing_admission_amount CHECK (authorized_micros >= 0 AND quantity = 1),
  CONSTRAINT ck_billing_admission_digest CHECK (pricing_snapshot_digest ~ '^[0-9a-f]{64}$')
);
CREATE TABLE IF NOT EXISTS billing_execution_event (
  id UUID NOT NULL PRIMARY KEY,
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
  lease_token UUID NULL,
  lease_until TIMESTAMPTZ(3) NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  dead_lettered_at TIMESTAMPTZ(3) NULL,
  last_error_code VARCHAR(128) NULL,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  processed_at TIMESTAMPTZ(3) NULL,
  CONSTRAINT uq_billing_execution_event_external UNIQUE (tenant_id, event_id),
  CONSTRAINT ck_billing_execution_event_type CHECK (event_type IN ('execution.waiting', 'execution.accepted', 'execution.rejected', 'execution.failed', 'execution.unknown')),
  CONSTRAINT ck_billing_execution_event_status CHECK (status IN ('received', 'processed', 'failed')),
  CONSTRAINT ck_billing_execution_event_lease CHECK ((lease_token IS NULL) = (lease_until IS NULL)),
  CONSTRAINT ck_billing_execution_event_attempts CHECK (attempts >= 0),
  CONSTRAINT ck_billing_execution_event_processed CHECK ((status = 'processed' AND processed_at IS NOT NULL AND dead_lettered_at IS NULL AND lease_token IS NULL) OR (status <> 'processed' AND processed_at IS NULL)),
  CONSTRAINT ck_billing_execution_event_dead_letter CHECK (dead_lettered_at IS NULL OR (status = 'failed' AND lease_token IS NULL))
);


-- Cross-table integrity is validated by Billing application transactions and reconciliation.

-- Deliberate access paths for tenant-scoped reads, dispatch leases and reconciliation.
CREATE INDEX IF NOT EXISTS ix_billing_credit_grant_expiry
  ON billing_credit_grant (tenant_id, expires_at, burn_priority, id)
  WHERE status IN ('pending', 'active');
CREATE INDEX IF NOT EXISTS ix_billing_credit_hold_expiry
  ON billing_credit_hold (tenant_id, expires_at, id)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS ix_billing_provider_event_processing
  ON billing_provider_event (processing_status, received_at, id)
  WHERE processing_status IN ('received', 'failed');
CREATE INDEX IF NOT EXISTS ix_billing_settlement_checkout
  ON billing_payment_settlement (tenant_id, checkout_id, created_at DESC, id DESC)
  WHERE checkout_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_billing_settlement_payment_intent
  ON billing_payment_settlement (provider_account_id, external_payment_intent_ref)
  WHERE external_payment_intent_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_billing_reversal_settlement
  ON billing_payment_reversal (tenant_id, settlement_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS ix_billing_checkout_status
  ON billing_checkout (tenant_id, status, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS ix_billing_checkout_not_started
  ON billing_checkout (created_at, id)
  WHERE session_creation_status = 'not_started';
CREATE INDEX IF NOT EXISTS ix_billing_checkout_unknown_due
  ON billing_checkout (next_attempt_at, id)
  WHERE session_creation_status = 'unknown';
CREATE INDEX IF NOT EXISTS ix_billing_checkout_expired_lease
  ON billing_checkout (session_lease_until, id)
  WHERE session_creation_status = 'in_flight';
CREATE INDEX IF NOT EXISTS ix_billing_subscription_term_subject
  ON billing_subscription_term (tenant_id, subject_id, period_start DESC, id DESC);
CREATE INDEX IF NOT EXISTS ix_billing_billing_admission_status
  ON billing_admission (tenant_id, status, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS ix_billing_execution_event_dispatch
  ON billing_execution_event (next_attempt_at, id)
  WHERE status IN ('received', 'failed') AND dead_lettered_at IS NULL AND lease_token IS NULL;
CREATE INDEX IF NOT EXISTS ix_billing_execution_event_expired_lease
  ON billing_execution_event (lease_until, id)
  WHERE status IN ('received', 'failed') AND dead_lettered_at IS NULL AND lease_until IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_billing_subscription_period_evidence_due
  ON billing_subscription_period (next_evidence_check_at, id)
  WHERE grant_status = 'waiting_evidence' AND next_evidence_check_at IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_command_receipt_identity
  ON billing_command_receipt (tenant_id, command_namespace, api_surface, command_name, command_identity)
  WHERE command_identity IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_outbox_payment_aggregate
  ON billing_outbox (aggregate_type, aggregate_id, event_type)
  WHERE event_namespace = 'payment';
CREATE INDEX IF NOT EXISTS ix_billing_outbox_dispatch
  ON billing_outbox (next_attempt_at, id)
  WHERE completed_at IS NULL AND dead_lettered_at IS NULL;
