import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import { createBillingConnection } from "../../src/infrastructure/postgres/connection.js";
import type { SqlConnection } from "../../src/infrastructure/postgres/connection.js";
import { createPostgresUsageSettlementService } from "../../src/infrastructure/postgres/create-postgres-services.js";
import { createUsageHoldDatabaseFixture } from "./usage-hold-binding.fixture.js";

const databaseUrl = process.env.DATABASE_URL;
const adminUrl = process.env.SCHEMA_ADMIN_URL;
const integration = describe.skipIf(databaseUrl === undefined);
async function waitForBlockedInserts(
  connection: PoolClient,
  count: number,
  table: string,
  blockerPid: number,
) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const result = await connection.query<{ pid: number }>(
      `SELECT pid FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
          AND wait_event = 'advisory' AND query LIKE $1
          AND $2 = ANY(pg_blocking_pids(pid))`,
      [`%INSERT INTO ${table}%`, blockerPid],
    );
    if (result.rows.length === count && result.rows[0])
      return result.rows[0].pid;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("usage insert barrier timeout");
}

async function waitForBlockedHold(connection: PoolClient, holderPid: number) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const result = await connection.query<{ count: number }>(
      `SELECT COUNT(*)::int count FROM pg_stat_activity
        WHERE datname = current_database()
          AND cardinality(pg_blocking_pids(pid)) > 0
          AND query LIKE '%FROM entitlement_credit_hold h%'
          AND $1 = ANY(pg_blocking_pids(pid))`,
      [holderPid],
    );
    if ((result.rows[0]?.count ?? 0) >= 1) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("settlement hold wait timeout");
}

async function seedHold(
  connection: SqlConnection,
  status: "active" | "released" | "captured" | "expired" = "active",
  tenantId = randomUUID(),
) {
  const accountId = randomUUID();
  const holdId = randomUUID();
  const subjectId = `subject-${randomUUID()}`;
  await connection.execute(
    `INSERT INTO entitlement_credit_account
      (credit_account_id, tenant_id, subject_id, available_micros, held_micros)
     VALUES ($1, $2, $3, 0, 10)`,
    [accountId, tenantId, subjectId],
  );
  await connection.execute(
    `INSERT INTO entitlement_credit_hold
      (credit_hold_id, tenant_id, credit_account_id, idempotency_key, requested_micros, expires_at, feature_key, status)
     VALUES ($1, $2, $3, $4, 10, CURRENT_TIMESTAMP + INTERVAL '5 minutes', 'model.request', $5)`,
    [holdId, tenantId, accountId, `hold-${randomUUID()}`, status],
  );
  return { tenantId, accountId, holdId, subjectId };
}

async function seedSettleableHold(connection: SqlConnection) {
  const seeded = await seedHold(connection);
  const grantId = randomUUID();
  await connection.execute(
    `INSERT INTO entitlement_credit_grant
      (credit_grant_id, tenant_id, credit_account_id, source_kind, source_ref, program_key,
       original_micros, remaining_micros, effective_at)
     VALUES ($1, $2, $3, 'test', $1, 'test', 10, 10, CURRENT_TIMESTAMP)`,
    [grantId, seeded.tenantId, seeded.accountId],
  );
  await connection.execute(
    `INSERT INTO entitlement_credit_hold_allocation
      (credit_hold_id, tenant_id, credit_grant_id, held_micros)
     VALUES ($1, $2, $3, 10)`,
    [seeded.holdId, seeded.tenantId, grantId],
  );
  return seeded;
}

integration("usage event to credit hold binding", () => {
  it("creates a UUID event and replays only the same hold/source binding", async () => {
    const connection = await createBillingConnection(databaseUrl ?? "");
    const usage = createPostgresUsageSettlementService(connection);
    try {
      const seeded = await seedHold(connection);
      const sourceEventId = `provider-${randomUUID()}`;
      const first = await usage.ensureUsageEventForHold({
        tenantId: seeded.tenantId,
        holdId: seeded.holdId,
        sourceEventId,
      });
      expect(first).toMatch(/^[0-9a-f-]{36}$/u);
      await expect(
        usage.ensureUsageEventForHold({
          tenantId: seeded.tenantId,
          holdId: seeded.holdId,
          sourceEventId,
        }),
      ).resolves.toBe(first);
      await expect(
        usage.ensureUsageEventForHold({
          tenantId: seeded.tenantId,
          holdId: seeded.holdId,
          sourceEventId: `other-${randomUUID()}`,
        }),
      ).rejects.toThrow("billing.idempotency_conflict");
      await connection.execute(
        `UPDATE entitlement_usage_event SET dimensions_json = '{"drift":true}'::jsonb
          WHERE usage_event_id = $1`,
        [first],
      );
      await expect(
        usage.ensureUsageEventForHold({
          tenantId: seeded.tenantId,
          holdId: seeded.holdId,
          sourceEventId,
        }),
      ).rejects.toThrow("billing.idempotency_conflict");
    } finally {
      await connection.end();
    }
  });

  it("does not claim a standalone source event and does not bind inactive holds", async () => {
    const connection = await createBillingConnection(databaseUrl ?? "");
    const usage = createPostgresUsageSettlementService(connection);
    try {
      const active = await seedHold(connection);
      const sourceEventId = `provider-${randomUUID()}`;
      await usage.recordUsageEvent({
        usageEventId: randomUUID(),
        tenantId: active.tenantId,
        subjectId: active.subjectId,
        sourceEventId,
        featureKey: "model.request",
        quantityMicros: 0,
      });
      await expect(
        usage.ensureUsageEventForHold({
          tenantId: active.tenantId,
          holdId: active.holdId,
          sourceEventId,
        }),
      ).rejects.toThrow("billing.idempotency_conflict");
      for (const status of ["released", "captured", "expired"] as const) {
        const inactive = await seedHold(connection, status);
        await expect(
          usage.ensureUsageEventForHold({
            tenantId: inactive.tenantId,
            holdId: inactive.holdId,
            sourceEventId: `provider-${randomUUID()}`,
          }),
        ).rejects.toThrow("billing.credit_hold_not_active");
        const [events] = await connection.query<{ count: string }[]>(
          "SELECT COUNT(*)::text count FROM entitlement_usage_event WHERE credit_hold_id = $1",
          [inactive.holdId],
        );
        expect(events).toEqual([{ count: "0" }]);
      }
    } finally {
      await connection.end();
    }
  });

  it.each([
    ["subject", "subject_id = 'drifted'"],
    ["feature", "feature_key = 'drifted'"],
    ["quantity", "quantity_micros = 1"],
    ["dimensions", "dimensions_json = '{\"drift\":true}'::jsonb"],
    ["tenant", "tenant_id = 'drifted'"],
  ] as const)(
    "rejects an independently drifted %s",
    async (_name, mutation) => {
      const connection = await createBillingConnection(databaseUrl ?? "");
      const usage = createPostgresUsageSettlementService(connection);
      try {
        const seeded = await seedHold(connection);
        const sourceEventId = `provider-${randomUUID()}`;
        const eventId = await usage.ensureUsageEventForHold({
          tenantId: seeded.tenantId,
          holdId: seeded.holdId,
          sourceEventId,
        });
        await connection.execute(
          `UPDATE entitlement_usage_event SET ${mutation} WHERE usage_event_id = $1`,
          [eventId],
        );
        await expect(
          usage.ensureUsageEventForHold({
            tenantId: seeded.tenantId,
            holdId: seeded.holdId,
            sourceEventId,
          }),
        ).rejects.toThrow("billing.idempotency_conflict");
      } finally {
        await connection.end();
      }
    },
  );

  it("rejects when hold and source identities resolve to two different rows", async () => {
    const connection = await createBillingConnection(databaseUrl ?? "");
    const usage = createPostgresUsageSettlementService(connection);
    try {
      const seeded = await seedHold(connection);
      await usage.ensureUsageEventForHold({
        tenantId: seeded.tenantId,
        holdId: seeded.holdId,
        sourceEventId: `bound-${randomUUID()}`,
      });
      const sourceEventId = `standalone-${randomUUID()}`;
      await usage.recordUsageEvent({
        usageEventId: randomUUID(),
        tenantId: seeded.tenantId,
        subjectId: seeded.subjectId,
        sourceEventId,
        featureKey: "model.request",
        quantityMicros: 0,
      });
      await expect(
        usage.ensureUsageEventForHold({
          tenantId: seeded.tenantId,
          holdId: seeded.holdId,
          sourceEventId,
        }),
      ).rejects.toThrow("billing.idempotency_conflict");
    } finally {
      await connection.end();
    }
  });

  it("allows exactly one source to win concurrent creation for a hold", async () => {
    const fixture = await createUsageHoldDatabaseFixture(adminUrl ?? "");
    const first = await createBillingConnection(fixture.url);
    const second = await createBillingConnection(fixture.url);
    const barrierPool = new Pool({ connectionString: fixture.url });
    const barrier = await barrierPool.connect();
    const barrierKey = Math.floor(Math.random() * 1_000_000_000);
    const barrierPid = (
      await barrier.query<{ pid: number }>("SELECT pg_backend_pid() pid")
    ).rows[0]?.pid;
    if (barrierPid === undefined) throw new Error("barrier backend missing");
    const inFlight: Promise<unknown>[] = [];
    try {
      await barrier.query(
        `CREATE FUNCTION block_usage_binding() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN PERFORM pg_advisory_xact_lock(${barrierKey}); RETURN NEW; END $$`,
      );
      await barrier.query(
        `CREATE TRIGGER block_usage_binding BEFORE INSERT ON entitlement_usage_event
         FOR EACH ROW WHEN (NEW.credit_hold_id IS NOT NULL) EXECUTE FUNCTION block_usage_binding()`,
      );
      const services = [first, second].map(
        createPostgresUsageSettlementService,
      );
      for (const sameSource of [true, false]) {
        const seeded = await seedHold(first);
        const sharedSource = `provider-${randomUUID()}`;
        await barrier.query("SELECT pg_advisory_lock($1)", [barrierKey]);
        const pending = Promise.allSettled(
          services.map((usage, index) =>
            usage.ensureUsageEventForHold({
              tenantId: seeded.tenantId,
              holdId: seeded.holdId,
              sourceEventId: sameSource
                ? sharedSource
                : `${sharedSource}-${index}`,
            }),
          ),
        );
        inFlight.push(pending);
        await waitForBlockedInserts(
          barrier,
          2,
          "entitlement_usage_event",
          barrierPid,
        );
        await barrier.query("SELECT pg_advisory_unlock($1)", [barrierKey]);
        const outcomes = await pending;
        const fulfilled = outcomes.filter(
          (item): item is PromiseFulfilledResult<string> =>
            item.status === "fulfilled",
        );
        expect(fulfilled).toHaveLength(sameSource ? 2 : 1);
        expect(new Set(fulfilled.map((item) => item.value)).size).toBe(1);
        expect(
          outcomes.filter((item) => item.status === "rejected"),
        ).toHaveLength(sameSource ? 0 : 1);
      }
      const sharedTenant = randomUUID();
      const holds = await Promise.all([
        seedHold(first, "active", sharedTenant),
        seedHold(first, "active", sharedTenant),
      ]);
      const sharedSource = `provider-${randomUUID()}`;
      await barrier.query("SELECT pg_advisory_lock($1)", [barrierKey]);
      const competingHolds = Promise.allSettled(
        services.map((usage, index) =>
          usage.ensureUsageEventForHold({
            tenantId: holds[index]?.tenantId ?? "",
            holdId: holds[index]?.holdId ?? "",
            sourceEventId: sharedSource,
          }),
        ),
      );
      inFlight.push(competingHolds);
      await waitForBlockedInserts(
        barrier,
        2,
        "entitlement_usage_event",
        barrierPid,
      );
      await barrier.query("SELECT pg_advisory_unlock($1)", [barrierKey]);
      const holdOutcomes = await competingHolds;
      expect(
        holdOutcomes.filter((item) => item.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        holdOutcomes.filter((item) => item.status === "rejected"),
      ).toHaveLength(1);
    } finally {
      await barrier
        .query("SELECT pg_advisory_unlock($1)", [barrierKey])
        .catch(() => undefined);
      await Promise.allSettled(inFlight);
      await barrier.query(
        "DROP TRIGGER IF EXISTS block_usage_binding ON entitlement_usage_event",
      );
      await barrier.query("DROP FUNCTION IF EXISTS block_usage_binding()");
      barrier.release();
      await Promise.all([first.end(), second.end(), barrierPool.end()]);
      await fixture.close();
    }
  });

  it("replays concurrent settlement after the waiter obtains the hold lock", async () => {
    const fixture = await createUsageHoldDatabaseFixture(adminUrl ?? "");
    const first = await createBillingConnection(fixture.url);
    const second = await createBillingConnection(fixture.url);
    const barrierPool = new Pool({ connectionString: fixture.url });
    const barrier = await barrierPool.connect();
    const barrierKey = Math.floor(Math.random() * 1_000_000_000);
    const barrierPid = (
      await barrier.query<{ pid: number }>("SELECT pg_backend_pid() pid")
    ).rows[0]?.pid;
    if (barrierPid === undefined) throw new Error("barrier backend missing");
    const inFlight: Promise<unknown>[] = [];
    try {
      const seeded = await seedSettleableHold(first);
      const eventId = randomUUID();
      await createPostgresUsageSettlementService(first).recordUsageEvent({
        usageEventId: eventId,
        tenantId: seeded.tenantId,
        subjectId: seeded.subjectId,
        sourceEventId: `provider-${randomUUID()}`,
        featureKey: "model.request",
        quantityMicros: 10,
      });
      await barrier.query("SELECT pg_advisory_lock($1)", [barrierKey]);
      await barrier.query(
        `CREATE FUNCTION block_settlement_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN IF NEW.aggregate_type = 'usage_settlement' THEN PERFORM pg_advisory_xact_lock(${barrierKey}); END IF; RETURN NEW; END $$`,
      );
      await barrier.query(
        `CREATE TRIGGER block_settlement_outbox BEFORE INSERT ON entitlement_outbox
         FOR EACH ROW EXECUTE FUNCTION block_settlement_outbox()`,
      );
      const settle = (connection: SqlConnection, index: number) =>
        createPostgresUsageSettlementService(connection).settleUsage({
          tenantId: seeded.tenantId,
          holdId: seeded.holdId,
          usageEventId: eventId,
          idempotencyKey: `settle-${index}-${randomUUID()}`,
          actualMicros: 10,
        });
      const holder = settle(first, 0);
      inFlight.push(holder);
      const holderPid = await waitForBlockedInserts(
        barrier,
        1,
        "entitlement_outbox",
        barrierPid,
      );
      const waiter = settle(second, 1);
      inFlight.push(waiter);
      await waitForBlockedHold(barrier, holderPid);
      await barrier.query("SELECT pg_advisory_unlock($1)", [barrierKey]);
      const results = await Promise.all([holder, waiter]);
      expect(results[1]).toEqual(results[0]);
      const [rows] = await first.query<
        { credit_hold_id: string; settlements: string; journals: string }[]
      >(
        `SELECT e.credit_hold_id,
                (SELECT COUNT(*) FROM entitlement_usage_settlement s WHERE s.credit_hold_id = $1)::text settlements,
                (SELECT COUNT(*) FROM entitlement_credit_journal j WHERE j.source_ref = $1)::text journals
           FROM entitlement_usage_event e WHERE e.usage_event_id = $2`,
        [seeded.holdId, eventId],
      );
      expect(rows).toEqual([
        { credit_hold_id: seeded.holdId, settlements: "1", journals: "1" },
      ]);
      await first.execute(
        "UPDATE entitlement_usage_event SET credit_hold_id = NULL WHERE usage_event_id = $1",
        [eventId],
      );
      await expect(settle(first, 2)).rejects.toThrow(
        "billing.credit_hold_not_active",
      );
    } finally {
      await barrier
        .query("SELECT pg_advisory_unlock($1)", [barrierKey])
        .catch(() => undefined);
      await Promise.allSettled(inFlight);
      await barrier.query(
        "DROP TRIGGER IF EXISTS block_settlement_outbox ON entitlement_outbox",
      );
      await barrier.query("DROP FUNCTION IF EXISTS block_settlement_outbox()");
      barrier.release();
      await Promise.all([first.end(), second.end(), barrierPool.end()]);
      await fixture.close();
    }
  });

  it("allows only one event to capture a hold and rolls the loser back", async () => {
    const first = await createBillingConnection(databaseUrl ?? "");
    const second = await createBillingConnection(databaseUrl ?? "");
    try {
      const seeded = await seedSettleableHold(first);
      const eventIds = [randomUUID(), randomUUID()];
      for (const eventId of eventIds)
        await createPostgresUsageSettlementService(first).recordUsageEvent({
          usageEventId: eventId,
          tenantId: seeded.tenantId,
          subjectId: seeded.subjectId,
          sourceEventId: `provider-${eventId}`,
          featureKey: "model.request",
          quantityMicros: 10,
        });
      const outcomes = await Promise.allSettled(
        [first, second].map((connection, index) =>
          createPostgresUsageSettlementService(connection).settleUsage({
            tenantId: seeded.tenantId,
            holdId: seeded.holdId,
            usageEventId: eventIds[index] ?? "",
            idempotencyKey: `settle-${index}-${randomUUID()}`,
            actualMicros: 10,
          }),
        ),
      );
      expect(
        outcomes.filter((item) => item.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        outcomes.filter((item) => item.status === "rejected"),
      ).toHaveLength(1);
      const [counts] = await first.query<
        { settlements: string; bound: string; recorded: string }[]
      >(
        `SELECT
          (SELECT COUNT(*) FROM entitlement_usage_settlement WHERE credit_hold_id = $1)::text settlements,
          (SELECT COUNT(*) FROM entitlement_usage_event WHERE credit_hold_id = $1)::text bound,
          (SELECT COUNT(*) FROM entitlement_usage_event WHERE usage_event_id = ANY($2) AND status = 'recorded')::text recorded`,
        [seeded.holdId, eventIds],
      );
      expect(counts).toEqual([{ settlements: "1", bound: "1", recorded: "1" }]);
    } finally {
      await Promise.all([first.end(), second.end()]);
    }
  });

  it("rejects an event bound to another active hold before changing funds", async () => {
    const fixture = await createUsageHoldDatabaseFixture(adminUrl ?? "");
    const connection = await createBillingConnection(fixture.url);
    try {
      const seeded = await seedSettleableHold(connection);
      const otherHoldId = randomUUID();
      await connection.execute(
        `INSERT INTO entitlement_credit_hold
          (credit_hold_id, tenant_id, credit_account_id, idempotency_key, requested_micros, expires_at, feature_key)
         VALUES ($1, $2, $3, $4, 10, CURRENT_TIMESTAMP + INTERVAL '5 minutes', 'model.request')`,
        [otherHoldId, seeded.tenantId, seeded.accountId, randomUUID()],
      );
      const usage = createPostgresUsageSettlementService(connection);
      const eventId = randomUUID();
      await usage.recordUsageEvent({
        usageEventId: eventId,
        tenantId: seeded.tenantId,
        subjectId: seeded.subjectId,
        sourceEventId: `provider-${randomUUID()}`,
        featureKey: "model.request",
        quantityMicros: 10,
      });
      await connection.execute(
        "UPDATE entitlement_usage_event SET credit_hold_id = $1 WHERE usage_event_id = $2",
        [otherHoldId, eventId],
      );
      await connection.execute(
        "UPDATE entitlement_usage_event SET status = 'settled' WHERE usage_event_id = $1",
        [eventId],
      );
      await expect(
        usage.settleUsage({
          tenantId: seeded.tenantId,
          holdId: seeded.holdId,
          usageEventId: eventId,
          idempotencyKey: randomUUID(),
          actualMicros: 10,
        }),
      ).rejects.toThrow("billing.usage_event_mismatch");
      const [state] = await connection.query<
        { held_micros: string; journals: string; settlements: string }[]
      >(
        `SELECT a.held_micros,
          (SELECT COUNT(*) FROM entitlement_credit_journal j WHERE j.credit_account_id = a.credit_account_id)::text journals,
          (SELECT COUNT(*) FROM entitlement_usage_settlement s WHERE s.credit_hold_id = $1)::text settlements
         FROM entitlement_credit_account a WHERE a.credit_account_id = $2`,
        [seeded.holdId, seeded.accountId],
      );
      expect(state).toEqual([
        { held_micros: "10", journals: "0", settlements: "0" },
      ]);
    } finally {
      await connection.end();
      await fixture.close();
    }
  });
});
