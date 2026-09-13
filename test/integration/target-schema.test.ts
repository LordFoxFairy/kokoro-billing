import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { withCanonicalReference } from "../../scripts/canonical-reference.js";
import { assertDefined } from "../assert-defined.js";

const adminUrl = process.env.SCHEMA_ADMIN_URL;
const integration = describe.skipIf(adminUrl === undefined);

integration("B8 target canonical schema", () => {
  it("installs exactly 32 billing-owned UUID resources without foreign keys", async () => {
    await withCanonicalReference(
      assertDefined(adminUrl),
      await readFile("database/schema.sql", "utf8"),
      async (url) => {
        const pool = new Pool({
          connectionString: publicSchemaUrl(url),
          max: 1,
        });
        try {
          const relations = await pool.query<{ name: string }>(
            "SELECT tablename name FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
          );
          expect(relations.rows).toHaveLength(32);
          expect(
            relations.rows.every(({ name }) => name.startsWith("billing_")),
          ).toBe(true);
          expect(relations.rows.map(({ name }) => name)).not.toEqual(
            expect.arrayContaining([
              "entitlement_acquisition",
              "entitlement_fulfillment",
              "payment_outbox",
              "payment_command_receipt",
            ]),
          );
          const primaryKeys = await pool.query<{ count: number }>(
            `SELECT COUNT(*)::int count FROM information_schema.table_constraints tc
             JOIN information_schema.key_column_usage k USING (constraint_catalog,constraint_schema,constraint_name,table_catalog,table_schema,table_name)
             JOIN information_schema.columns c ON c.table_schema=k.table_schema AND c.table_name=k.table_name AND c.column_name=k.column_name
             WHERE tc.table_schema='public' AND tc.constraint_type='PRIMARY KEY'
               AND k.column_name='id' AND c.udt_name='uuid'`,
          );
          expect(primaryKeys.rows[0]?.count).toBe(32);
          const foreignKeys = await pool.query<{ count: number }>(
            "SELECT COUNT(*)::int count FROM information_schema.table_constraints WHERE table_schema='public' AND constraint_type='FOREIGN KEY'",
          );
          expect(foreignKeys.rows[0]?.count).toBe(0);
        } finally {
          await pool.end();
        }
      },
    );
  });

  it("enforces unified receipt, outbox, fulfillment and zero-delta reversal invariants", async () => {
    await withCanonicalReference(
      assertDefined(adminUrl),
      await readFile("database/schema.sql", "utf8"),
      async (url) => {
        const pool = new Pool({
          connectionString: publicSchemaUrl(url),
          max: 1,
        });
        try {
          const invalid = [
            `INSERT INTO billing_command_receipt (id,tenant_id,command_namespace,api_surface,command_name,request_schema_version,payload_digest,status) VALUES (gen_random_uuid(),'t','bad','internal','c',1,repeat('a',64),'processing')`,
            `INSERT INTO billing_outbox (id,tenant_id,event_namespace,aggregate_type,aggregate_id,event_type,event_identity,payload_schema_version,payload_digest,payload_json,attempts,next_attempt_at,requeue_generation) VALUES (gen_random_uuid(),'t','credit','a',gen_random_uuid(),'e','i',0,repeat('a',64),'{}',0,now(),0)`,
            `INSERT INTO billing_credit_fulfillment_reversal (id,tenant_id,fulfillment_id,payment_reversal_id,amount_micros,journal_id,policy_version,input_digest,refund_amount_minor,prior_refund_amount_minor,prior_credit_micros,settlement_amount_minor,fulfillment_authorized_micros,grant_original_micros,grant_remaining_micros_before,grant_status_before) VALUES (gen_random_uuid(),'t',gen_random_uuid(),gen_random_uuid(),0,gen_random_uuid(),1,repeat('a',64),1,0,0,1,1,1,1,'active')`,
            `INSERT INTO billing_command_receipt (id,tenant_id,command_namespace,api_surface,command_name,request_schema_version,payload_digest,status,result_json) VALUES (gen_random_uuid(),'t','general','internal','c',1,repeat('a',64),'processing','{}')`,
            `INSERT INTO billing_command_receipt (id,tenant_id,command_namespace,api_surface,command_name,request_schema_version,payload_digest,status,result_schema_version) VALUES (gen_random_uuid(),'t','general','internal','c',1,repeat('a',64),'unknown',1)`,
          ];
          for (const sql of invalid)
            await expect(pool.query(sql)).rejects.toMatchObject({
              code: "23514",
            });
        } finally {
          await pool.end();
        }
      },
    );
  });

  it("rejects malformed checkout recovery states from otherwise valid rows", async () => {
    await withCanonicalReference(
      assertDefined(adminUrl),
      await readFile("database/schema.sql", "utf8"),
      async (url) => {
        const pool = new Pool({
          connectionString: publicSchemaUrl(url),
          max: 1,
        });
        try {
          const cases = [
            {
              key: "ready-null-status",
              state: "'ready'",
              providerKey: "'key-1'",
              sessionId: "'cs_1'",
              providerStatus: "NULL",
            },
            {
              key: "empty-provider-key",
              state: "'not_started'",
              providerKey: "''",
              sessionId: "NULL",
              providerStatus: "NULL",
            },
            {
              key: "invalid-provider-status",
              state: "'not_started'",
              providerKey: "'key-3'",
              sessionId: "NULL",
              providerStatus: "'arbitrary'",
            },
          ];
          for (const row of cases) {
            const sql = `INSERT INTO billing_checkout
              (id,provider,provider_account_id,provider_account_ref,provider_environment,checkout_session_mode,provider_idempotency_key,provider_request_json,provider_request_digest,provider_session_id,provider_session_status,tenant_id,subject_id,idempotency_key,offer_revision_id,quote_hash,quote_snapshot_json,amount_minor,currency_code,status,quote_expires_at,session_creation_status)
              VALUES (gen_random_uuid(),'stripe',gen_random_uuid(),'acct','test','payment',${row.providerKey},'{}',repeat('a',64),${row.sessionId},${row.providerStatus},'t','s','${row.key}',gen_random_uuid(),repeat('b',64),'{}',1,'USD','created',now()+interval '1 hour',${row.state})`;
            await expect(pool.query(sql)).rejects.toMatchObject({
              code: "23514",
            });
          }
        } finally {
          await pool.end();
        }
      },
    );
  });

  it("enforces merged identity domains and durable terminal-state checks", async () => {
    await withCanonicalReference(
      assertDefined(adminUrl),
      await readFile("database/schema.sql", "utf8"),
      async (url) => {
        const pool = new Pool({
          connectionString: publicSchemaUrl(url),
          max: 1,
        });
        const conflict = async (sql: string, constraint: string) => {
          await expect(pool.query(sql)).rejects.toMatchObject({
            code: "23505",
            constraint,
          });
        };
        const check = async (sql: string, constraint: string) => {
          await expect(pool.query(sql)).rejects.toMatchObject({
            code: "23514",
            constraint,
          });
        };
        try {
          const receipt = (id: string, identity: string) =>
            `INSERT INTO billing_command_receipt (id,tenant_id,command_namespace,api_surface,command_name,command_identity,request_schema_version,payload_digest,status) VALUES ('${id}'::uuid,'t','general','internal','command','${identity}',1,repeat('a',64),'processing')`;
          const firstReceipt = "00000000-0000-4000-8000-000000000011";
          await pool.query(receipt(firstReceipt, "identity-1"));
          await pool.query(
            `INSERT INTO billing_command_key_binding (id,tenant_id,command_namespace,api_surface,command_name,idempotency_key,command_receipt_id) VALUES (gen_random_uuid(),'t','general','internal','command','key-1','${firstReceipt}'::uuid)`,
          );
          await conflict(
            `INSERT INTO billing_command_key_binding (id,tenant_id,command_namespace,api_surface,command_name,idempotency_key,command_receipt_id) VALUES (gen_random_uuid(),'t','general','internal','command','key-1',gen_random_uuid())`,
            "uq_billing_command_key_binding_scope",
          );
          await conflict(
            receipt("00000000-0000-4000-8000-000000000012", "identity-1"),
            "uq_billing_command_receipt_identity",
          );

          const outbox = (
            namespace: string,
            identity: string,
            aggregateId: string,
          ) =>
            `INSERT INTO billing_outbox (id,tenant_id,event_namespace,aggregate_type,aggregate_id,event_type,event_identity,payload_schema_version,payload_digest,payload_json) VALUES (gen_random_uuid(),'t','${namespace}','aggregate','${aggregateId}'::uuid,'event','${identity}',1,repeat('a',64),'{}')`;
          const aggregateId = "00000000-0000-4000-8000-000000000001";
          await pool.query(outbox("payment", "outbox-1", aggregateId));
          await conflict(
            outbox(
              "payment",
              "outbox-1",
              "00000000-0000-4000-8000-000000000002",
            ),
            "uq_billing_outbox_identity",
          );
          await conflict(
            outbox("payment", "outbox-2", aggregateId),
            "uq_billing_outbox_payment_aggregate",
          );
          await pool.query(outbox("credit", "outbox-3", aggregateId));

          const fulfillment = (
            source: string,
            grant: string,
            journal: string,
          ) =>
            `INSERT INTO billing_credit_fulfillment (id,tenant_id,subject_id,credit_account_id,source_kind,source_ref,program_key,authorized_micros,effective_at,authorization_policy_version,authorization_digest,credit_grant_id,grant_journal_id) VALUES (gen_random_uuid(),'t','s',gen_random_uuid(),'payment_settlement','${source}','p',1,now(),1,repeat('a',64),'${grant}'::uuid,'${journal}'::uuid)`;
          const grant = "00000000-0000-4000-8000-000000000011";
          const journal = "00000000-0000-4000-8000-000000000012";
          await pool.query(fulfillment("source-1", grant, journal));
          await conflict(
            fulfillment(
              "source-1",
              "00000000-0000-4000-8000-000000000013",
              "00000000-0000-4000-8000-000000000014",
            ),
            "uq_billing_credit_fulfillment_source",
          );
          await conflict(
            fulfillment(
              "source-2",
              grant,
              "00000000-0000-4000-8000-000000000015",
            ),
            "uq_billing_credit_fulfillment_grant",
          );
          await conflict(
            fulfillment(
              "source-3",
              "00000000-0000-4000-8000-000000000016",
              journal,
            ),
            "uq_billing_credit_fulfillment_journal",
          );

          const period = (
            invoice: string,
            line: string,
            start: string,
            grantState = "waiting_evidence",
            completed = "NULL",
            fulfillmentId = "NULL",
            evidenceStart = "NULL",
            evidenceDeadline = "NULL",
          ) =>
            `INSERT INTO billing_subscription_period (id,tenant_id,provider_subscription_id,provider_account_id,subscription_item_ref,external_invoice_ref,external_invoice_line_ref,program_key,authorized_micros,authorization_policy_version,authorization_digest,period_start,period_end,invoice_status,settlement_evidence_kind,source_event_id,evidence_schema_version,evidence_digest,evidence_json,grant_status,grant_completed_at,credit_fulfillment_id,evidence_check_started_at,evidence_check_deadline_at) VALUES (gen_random_uuid(),'t','00000000-0000-4000-8000-000000000021','00000000-0000-4000-8000-000000000022','item','${invoice}','${line}','program',1,1,repeat('a',64),'${start}'::timestamptz,'${start}'::timestamptz+interval '1 month','paid','payment',gen_random_uuid(),1,repeat('b',64),'{}','${grantState}',${completed},${fulfillmentId},${evidenceStart},${evidenceDeadline})`;
          await pool.query(period("invoice-1", "line-1", "2026-01-01"));
          await conflict(
            period("invoice-1", "line-1", "2026-02-01"),
            "uq_billing_subscription_period_invoice",
          );
          await conflict(
            period("invoice-2", "line-2", "2026-01-01"),
            "uq_billing_subscription_period_window",
          );
          await check(
            period("invoice-3", "line-3", "2026-03-01", "applied"),
            "ck_billing_subscription_period_applied",
          );
          await check(
            period(
              "invoice-4",
              "line-4",
              "2026-04-01",
              "waiting_evidence",
              "NULL",
              "NULL",
              "'2026-04-02'",
              "'2026-04-01'",
            ),
            "ck_billing_subscription_period_evidence_window",
          );

          const reversal = (
            effect: string,
            completed = "NULL",
            fulfillmentId = "NULL",
            grantId = "NULL",
            policy = "NULL",
          ) =>
            `INSERT INTO billing_payment_reversal (id,provider,provider_account_id,tenant_id,settlement_id,external_reversal_ref,amount_minor,currency_code,reason,status,credit_effect_status,credit_effect_completed_at,credit_fulfillment_id,credit_grant_id,allocation_policy_version) VALUES (gen_random_uuid(),'stripe',gen_random_uuid(),'t',gen_random_uuid(),gen_random_uuid()::text,1,'USD','reason','succeeded','${effect}',${completed},${fulfillmentId},${grantId},${policy})`;
          await pool.query(reversal("pending"));
          await check(reversal("applied"), "ck_billing_reversal_applied");

          const execution = (
            status: string,
            processedAt = "NULL",
            deadAt = "NULL",
            token = "NULL",
            lease = "NULL",
          ) =>
            `INSERT INTO billing_execution_event (id,event_id,tenant_id,execution_id,invocation_id,event_type,occurred_at,receipt_schema_version,payload_hash,status,processed_at,dead_lettered_at,lease_token,lease_until) VALUES (gen_random_uuid(),gen_random_uuid()::text,'t','execution','invocation','execution.accepted',now(),'v1',repeat('a',64),'${status}',${processedAt},${deadAt},${token},${lease})`;
          await pool.query(execution("failed"));
          await pool.query(execution("processed", "now()"));
          await check(
            execution("processed"),
            "ck_billing_execution_event_processed",
          );
          await check(
            execution("received", "NULL", "now()"),
            "ck_billing_execution_event_dead_letter",
          );
          await check(
            execution(
              "failed",
              "NULL",
              "now()",
              "gen_random_uuid()",
              "now()+interval '1 minute'",
            ),
            "ck_billing_execution_event_dead_letter",
          );
          await check(
            `INSERT INTO billing_provider_event (id,processing_attempts,tenant_id,provider,external_event_id,event_type,payload_json,signature_valid) VALUES (gen_random_uuid(),-1,'t','stripe',gen_random_uuid()::text,'event','{}',true)`,
            "ck_billing_provider_event_attempts",
          );
        } finally {
          await pool.end();
        }
      },
    );
  });
});

function publicSchemaUrl(raw: string): string {
  const url = new URL(raw);
  url.searchParams.set("options", "-c search_path=public,pg_catalog");
  return url.toString();
}
