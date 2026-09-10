import { assertDefined } from "../assert-defined.js";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createBillingConnection,
  runWithBillingContext,
} from "../../src/infrastructure/postgres/connection.js";
import type {
  SqlConnection,
  RowDataPacket,
} from "../../src/infrastructure/postgres/database.js";
import {
  createPostgresAdminGrantService,
  createPostgresBillingSettlementService,
  createPostgresReconciliationService,
} from "../../src/infrastructure/postgres/create-postgres-services.js";

const databaseUrl = process.env.DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);

// Observe actual SQL and inject failures around it; never replace report rows.
function observeReport(
  connection: SqlConnection,
  hooks: {
    before?: (sql: string) => Promise<void>;
    after?: (sql: string) => Promise<void>;
  },
): SqlConnection {
  return {
    query: async <T = RowDataPacket[]>(
      sql: string,
      values?: unknown[],
    ): Promise<[T, unknown[]]> => {
      await hooks.before?.(sql);
      const result = await connection.query<T>(sql, values);
      await hooks.after?.(sql);
      return result;
    },
    execute: connection.execute.bind(connection),
    beginTransaction: connection.beginTransaction.bind(connection),
    commit: connection.commit.bind(connection),
    rollback: connection.rollback.bind(connection),
    withTransaction: connection.withTransaction.bind(connection),
    ping: connection.ping.bind(connection),
    end: connection.end.bind(connection),
  };
}

const isAccountScan = (sql: string) =>
  sql.includes("FROM entitlement_credit_account a");

async function sessionState(connection: SqlConnection) {
  const [rows] = await connection.query<
    {
      pid: number;
      isolation: string;
      read_only: string;
      statement_timeout: string;
      idle_timeout: string;
    }[]
  >(`SELECT pg_catalog.pg_backend_pid() AS pid,
    pg_catalog.current_setting('transaction_isolation') AS isolation,
    pg_catalog.current_setting('transaction_read_only') AS read_only,
    pg_catalog.current_setting('statement_timeout') AS statement_timeout,
    pg_catalog.current_setting('idle_in_transaction_session_timeout') AS idle_timeout`);
  return assertDefined(rows[0]);
}

async function insertAccount(
  connection: SqlConnection,
  tenantId: string,
  accountId: string,
) {
  await connection.execute(
    "INSERT INTO entitlement_credit_account (credit_account_id, tenant_id, subject_id) VALUES ($1, $2, $3)",
    [accountId, tenantId, randomUUID()],
  );
}

async function twoClientConnection() {
  const previous = process.env.POSTGRES_POOL_SIZE;
  process.env.POSTGRES_POOL_SIZE = "2";
  try {
    return await createBillingConnection(assertDefined(databaseUrl));
  } finally {
    if (previous === undefined) delete process.env.POSTGRES_POOL_SIZE;
    else process.env.POSTGRES_POOL_SIZE = previous;
  }
}

integration("billing reconciliation", () => {
  it("detects projection drift against grant and journal facts", async () => {
    const connection = await createBillingConnection(
      assertDefined(databaseUrl),
    );
    const tenantId = randomUUID();
    const accountId = randomUUID();
    try {
      await createPostgresAdminGrantService(connection).grant({
        tenantId,
        subjectId: randomUUID(),
        accountId,
        amountMicros: 10,
        programKey: "reconcile",
        operatorId: "operator-1",
        reason: "test",
        idempotencyKey: `reconcile-${randomUUID()}`,
      });
      const service = createPostgresReconciliationService(connection);
      expect((await service.run(tenantId)).status).toBe("ok");
      await connection.execute(
        "UPDATE entitlement_credit_account SET available_micros = available_micros + 1 WHERE credit_account_id = $1",
        [accountId],
      );
      const report = await service.run(tenantId);
      expect(report.status).toBe("drift");
      expect(report.accountDrifts).toHaveLength(1);
    } finally {
      await connection.end();
    }
  });

  it("detects held projection drift against active holds and allocations", async () => {
    const connection = await createBillingConnection(
      assertDefined(databaseUrl),
    );
    const tenantId = randomUUID();
    const accountId = randomUUID();
    const holdId = randomUUID();
    try {
      await connection.execute(
        `INSERT INTO entitlement_credit_account (credit_account_id, tenant_id, subject_id, available_micros, held_micros) VALUES ($1, $2, $3, 0, 10)`,
        [accountId, tenantId, `subject-${accountId}`],
      );
      await connection.execute(
        `INSERT INTO entitlement_credit_hold (credit_hold_id, tenant_id, credit_account_id, idempotency_key, requested_micros, expires_at) VALUES ($1, $2, $3, $4, 10, CURRENT_TIMESTAMP(3) + INTERVAL '5 minutes')`,
        [holdId, tenantId, accountId, `reconcile-hold-${holdId}`],
      );
      const report =
        await createPostgresReconciliationService(connection).run(tenantId);
      expect(report.status).toBe("drift");
      expect(report.accountDrifts[0]).toMatchObject({
        heldMicros: "10",
        activeHoldMicros: "10",
        activeAllocationMicros: "0",
      });
    } finally {
      await connection.execute(
        "DELETE FROM entitlement_credit_hold WHERE credit_hold_id = $1",
        [holdId],
      );
      await connection.execute(
        "DELETE FROM entitlement_credit_account WHERE credit_account_id = $1",
        [accountId],
      );
      await connection.end();
    }
  });

  it("detects payment fulfillment gaps and failed provider events", async () => {
    const connection = await createBillingConnection(
      assertDefined(databaseUrl),
    );
    const tenantId = randomUUID();
    const settlementId = randomUUID();
    const providerEventId = randomUUID();
    try {
      await connection.execute(
        `INSERT INTO payment_settlement (settlement_id, tenant_id, provider, external_payment_ref, amount_minor, currency, status)
         VALUES ($1, $2, 'stripe', $3, 100, 'USD', 'succeeded')`,
        [settlementId, tenantId, `reconcile-payment-${settlementId}`],
      );
      await connection.execute(
        `INSERT INTO payment_provider_event
          (provider_event_id, tenant_id, provider, external_event_id, event_type, payload_json, payload_hash, signature_valid, processing_status, processing_attempts, last_error)
         VALUES ($1, $2, 'mock', $3, 'payment.succeeded', '{}', REPEAT('a', 64), true, 'failed', 2, 'temporary')`,
        [providerEventId, tenantId, `evt-${providerEventId}`],
      );
      const report =
        await createPostgresReconciliationService(connection).run(tenantId);
      expect(report.status).toBe("drift");
      expect(report.settlementDrifts).toHaveLength(1);
      expect(report.providerEventDrifts).toHaveLength(1);
    } finally {
      await connection.execute(
        "DELETE FROM payment_provider_event WHERE provider_event_id = $1",
        [providerEventId],
      );
      await connection.execute(
        "DELETE FROM payment_settlement WHERE settlement_id = $1",
        [settlementId],
      );
      await connection.end();
    }
  });

  it("detects a succeeded reversal without a committed fulfillment reversal", async () => {
    const connection = await createBillingConnection(
      assertDefined(databaseUrl),
    );
    const service = createPostgresBillingSettlementService(connection);
    const tenantId = randomUUID();
    const settlementId = randomUUID();
    const reversalId = randomUUID();
    const accountId = randomUUID();
    try {
      await service.recordSettlement({
        settlementId,
        tenantId,
        idempotencyKey: `settlement-${settlementId}`,
        externalPaymentRef: `reconcile-reversal-${settlementId}`,
        amountMinor: 100,
        currency: "USD",
      });
      await service.fulfillSettlement({
        settlementId,
        tenantId,
        accountId,
        subjectId: `subject-${accountId}`,
        programKey: "reconcile",
        grantMicros: 10,
      });
      await connection.execute(
        `INSERT INTO payment_reversal (reversal_id, tenant_id, settlement_id, provider, external_reversal_ref, amount_minor, reason, status)
         VALUES ($1, $2, $3, 'internal', $4, 100, 'customer_request', 'succeeded')`,
        [reversalId, tenantId, settlementId, `refund-${reversalId}`],
      );
      const report =
        await createPostgresReconciliationService(connection).run(tenantId);
      expect(report.reversalDrifts).toHaveLength(1);
      expect(report.reversalDrifts[0]).toMatchObject({
        reversalId,
        fulfillmentReversalId: null,
      });
    } finally {
      await connection.end();
    }
  });

  it("does not report false ok when an atomic commit moves drift between two scans", async () => {
    const reader = await createBillingConnection(assertDefined(databaseUrl));
    const writer = await createBillingConnection(assertDefined(databaseUrl));
    const tenantId = randomUUID();
    const accountId = randomUUID();
    const settlementId = randomUUID();
    const acquisitionId = randomUUID();
    let switched = false;
    try {
      await insertAccount(writer, tenantId, accountId);
      await writer.execute(
        "INSERT INTO payment_settlement (settlement_id, tenant_id, provider, external_payment_ref, amount_minor, currency, status) VALUES ($1, $2, 's3-fixture', $1, 100, 'USD', 'succeeded')",
        [settlementId, tenantId],
      );
      const service = createPostgresReconciliationService(reader);
      const before = await service.run(tenantId);
      expect(before.status).toBe("drift");
      expect(before.accountDrifts).toEqual([]);
      expect(before.settlementDrifts).toHaveLength(1);
      const observed = observeReport(reader, {
        after: async (sql) => {
          if (switched || !isAccountScan(sql)) return;
          switched = true;
          // Both committed fixture states are inconsistent; only a mixed snapshot looks ok.
          await runWithBillingContext(() =>
            writer.withTransaction(async () => {
              await writer.execute(
                "UPDATE entitlement_credit_account SET available_micros = 1 WHERE tenant_id = $1 AND credit_account_id = $2",
                [tenantId, accountId],
              );
              await writer.execute(
                "INSERT INTO entitlement_acquisition (acquisition_id, tenant_id, subject_id, source_kind, source_ref, program_key, quantity_micros) VALUES ($1, $2, 's3-fixture', 'payment_settlement', $3, 's3-fixture', 1)",
                [acquisitionId, tenantId, settlementId],
              );
              await writer.execute(
                "INSERT INTO entitlement_fulfillment (fulfillment_id, tenant_id, acquisition_id, status, committed_at) VALUES ($1, $2, $3, 'committed', CURRENT_TIMESTAMP)",
                [randomUUID(), tenantId, acquisitionId],
              );
            }),
          );
        },
      });
      const during =
        await createPostgresReconciliationService(observed).run(tenantId);
      const after = await service.run(tenantId);
      expect(switched).toBe(true);
      expect(after.status).toBe("drift");
      expect(after.accountDrifts).toHaveLength(1);
      expect(after.settlementDrifts).toEqual([]);
      expect(during).toEqual(before);
      // Existing optional-tenant scan remains available and sees a fresh committed snapshot.
      expect((await service.run()).accountDrifts).toEqual(
        expect.arrayContaining([...after.accountDrifts]),
      );
    } finally {
      await Promise.all([reader.end(), writer.end()]);
    }
  });

  it.each([
    { statement: "0", idle: "0" },
    { statement: "4s", idle: "8s" },
  ])(
    "sets snapshot before queries, caps report budgets, and restores client defaults $statement/$idle",
    async ({ statement, idle }) => {
      const connection = await createBillingConnection(
        assertDefined(databaseUrl),
      );
      const statements: string[] = [];
      try {
        // Only this test's idle pool client has fixture session defaults.
        await connection.query(
          "SELECT pg_catalog.set_config('statement_timeout', $1, false), pg_catalog.set_config('idle_in_transaction_session_timeout', $2, false)",
          [statement, idle],
        );
        const original = await sessionState(connection);
        const observed = observeReport(connection, {
          before: async (sql) => {
            statements.push(sql);
            if (isAccountScan(sql)) {
              expect(await sessionState(connection)).toEqual({
                ...original,
                isolation: "repeatable read",
                read_only: "on",
                statement_timeout: "2s",
                idle_timeout: "5s",
              });
            }
          },
        });
        expect(
          (
            await createPostgresReconciliationService(observed).run(
              randomUUID(),
            )
          ).status,
        ).toBe("ok");
        expect(assertDefined(statements[0]).trim()).toBe(
          "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
        );
        expect(await sessionState(connection)).toEqual(original);
      } finally {
        await connection.end();
      }
    },
  );

  it.each(["read-only write", "SQL failure", "scan-stage JS failure"] as const)(
    "rolls back %s and reuses the released client",
    async (fault) => {
      const connection = await createBillingConnection(
        assertDefined(databaseUrl),
      );
      const tenantId = randomUUID();
      const accountId = randomUUID();
      let injected: unknown;
      let didInject = false;
      try {
        await insertAccount(connection, tenantId, accountId);
        const original = await sessionState(connection);
        const observed = observeReport(connection, {
          after: async (sql) => {
            if (!isAccountScan(sql)) return;
            didInject = true;
            try {
              if (fault === "read-only write") {
                await connection.execute(
                  "UPDATE entitlement_credit_account SET available_micros = 1 WHERE tenant_id = $1 AND credit_account_id = $2",
                  [tenantId, accountId],
                );
              } else if (fault === "SQL failure") {
                await connection.query("SELECT 1 / 0");
              } else {
                // Explicit scan-stage JS injection, not a claim that canonical bigint can store invalid text.
                BigInt("invalid");
              }
            } catch (error) {
              injected = error;
              throw error;
            }
          },
        });
        const operation =
          createPostgresReconciliationService(observed).run(tenantId);
        if (fault === "scan-stage JS failure")
          await expect(operation).rejects.toBeInstanceOf(SyntaxError);
        else
          await expect(operation).rejects.toMatchObject({
            code: fault === "read-only write" ? "25006" : "22012",
          });
        await expect(operation).rejects.toBe(injected);
        expect(didInject).toBe(true);
        expect(await sessionState(connection)).toEqual(original);
        const [accounts] = await connection.query<
          { available_micros: string }[]
        >(
          "SELECT available_micros FROM entitlement_credit_account WHERE tenant_id = $1 AND credit_account_id = $2",
          [tenantId, accountId],
        );
        expect(accounts).toEqual([{ available_micros: "0" }]);
        expect(
          (await createPostgresReconciliationService(connection).run(tenantId))
            .status,
        ).toBe("ok");
      } finally {
        await connection.end();
      }
    },
  );

  it.each([false, true])(
    "isolates a pool-2 caller from the report and preserves stricter report budgets (SQL timeout=%s)",
    async (fail) => {
      const connection = await twoClientConnection();
      const tenantId = randomUUID();
      const accountId = randomUUID();
      try {
        await insertAccount(connection, tenantId, accountId);
        await runWithBillingContext(async () => {
          await connection.beginTransaction();
          try {
            await connection.query(
              "SELECT pg_catalog.set_config('statement_timeout', '3s', true), pg_catalog.set_config('idle_in_transaction_session_timeout', '9s', true)",
            );
            await connection.execute(
              "UPDATE entitlement_credit_account SET available_micros = 5 WHERE tenant_id = $1 AND credit_account_id = $2",
              [tenantId, accountId],
            );
            const caller = await sessionState(connection);
            // Caller holds client 1; this separate context configures only idle client 2.
            const reportClient = await runWithBillingContext(async () => {
              await connection.query(
                "SELECT pg_catalog.set_config('statement_timeout', '50ms', false), pg_catalog.set_config('idle_in_transaction_session_timeout', '400ms', false)",
              );
              return sessionState(connection);
            });
            expect(reportClient.pid).not.toBe(caller.pid);
            let reportPid: number | undefined;
            const observed = observeReport(connection, {
              before: async (sql) => {
                if (!isAccountScan(sql)) return;
                const report = await sessionState(connection);
                reportPid = report.pid;
                expect(report).toEqual({
                  ...reportClient,
                  isolation: "repeatable read",
                  read_only: "on",
                });
                if (fail)
                  await connection.query("SELECT pg_catalog.pg_sleep(1)");
              },
            });
            const operation =
              createPostgresReconciliationService(observed).run(tenantId);
            if (fail)
              await expect(operation).rejects.toMatchObject({ code: "57014" });
            else
              expect(await operation).toEqual({
                status: "ok",
                accountDrifts: [],
                settlementDrifts: [],
                reversalDrifts: [],
                providerEventDrifts: [],
              });
            expect(reportPid).toBe(reportClient.pid);
            expect(await sessionState(connection)).toEqual(caller);
            const [beforeWrite] = await connection.query<
              { available_micros: string }[]
            >(
              "SELECT available_micros FROM entitlement_credit_account WHERE tenant_id = $1 AND credit_account_id = $2",
              [tenantId, accountId],
            );
            expect(beforeWrite).toEqual([{ available_micros: "5" }]);
            await connection.execute(
              "UPDATE entitlement_credit_account SET available_micros = 7 WHERE tenant_id = $1 AND credit_account_id = $2",
              [tenantId, accountId],
            );
            const [afterWrite] = await connection.query<
              { available_micros: string }[]
            >(
              "SELECT available_micros FROM entitlement_credit_account WHERE tenant_id = $1 AND credit_account_id = $2",
              [tenantId, accountId],
            );
            expect(afterWrite).toEqual([{ available_micros: "7" }]);
            expect(
              await runWithBillingContext(() => sessionState(connection)),
            ).toEqual(reportClient);
          } finally {
            await connection.rollback();
          }
        });
        const [rolledBack] = await connection.query<
          { available_micros: string }[]
        >(
          "SELECT available_micros FROM entitlement_credit_account WHERE tenant_id = $1 AND credit_account_id = $2",
          [tenantId, accountId],
        );
        expect(rolledBack).toEqual([{ available_micros: "0" }]);
        expect(
          (await createPostgresReconciliationService(connection).run(tenantId))
            .status,
        ).toBe("ok");
      } finally {
        await connection.end();
      }
    },
  );
});
