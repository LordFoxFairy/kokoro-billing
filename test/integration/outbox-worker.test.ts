import { assertDefined } from "../assert-defined.js";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createBillingConnection } from "../../src/infrastructure/postgres/connection.js";
import type { RowDataPacket } from "../../src/infrastructure/postgres/connection.js";
import { OutboxWorker } from "../../src/infrastructure/postgres/outbox-worker.js";

const databaseUrl = process.env.DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);

integration("PostgreSQL outbox worker", () => {
  it("claims, publishes and marks one event exactly once", async () => {
    const connection = await createBillingConnection(
      assertDefined(databaseUrl),
    );
    const outboxId = randomUUID();
    const tenantId = randomUUID();
    let calls = 0;
    try {
      await connection.execute(
        `INSERT INTO entitlement_outbox (outbox_id, tenant_id, aggregate_type, aggregate_id, event_type, payload_json)
         VALUES ($1, $2, 'test', $3, 'TestEvent', $4)`,
        [outboxId, tenantId, randomUUID(), JSON.stringify({ outboxId })],
      );
      const worker = new OutboxWorker(
        connection,
        "entitlement_outbox",
        30,
        "TestEvent",
        10,
        tenantId,
      );
      expect(
        await worker.processOnce(async (event) => {
          calls += 1;
          expect(event.outboxId).toBe(outboxId);
          return Promise.resolve();
        }),
      ).toBe("published");
      expect(
        await worker.processOnce(async () => {
          calls += 1;
          return Promise.resolve();
        }),
      ).toBe(false);
      expect(calls).toBe(1);
      const [rows] = await connection.query<
        (RowDataPacket & { published_at: Date | null })[]
      >("SELECT published_at FROM entitlement_outbox WHERE outbox_id = $1", [
        outboxId,
      ]);
      expect(rows[0]?.published_at).not.toBeNull();
    } finally {
      await connection.end();
    }
  });

  it("dead-letters a poison event after the configured attempt budget", async () => {
    const connection = await createBillingConnection(
      assertDefined(databaseUrl),
    );
    const outboxId = randomUUID();
    const tenantId = randomUUID();
    try {
      await connection.execute(
        `INSERT INTO entitlement_outbox (outbox_id, tenant_id, aggregate_type, aggregate_id, event_type, payload_json)
         VALUES ($1, $2, 'test', $3, 'PoisonTestEvent', $4)`,
        [outboxId, tenantId, randomUUID(), JSON.stringify({ outboxId })],
      );
      const worker = new OutboxWorker(
        connection,
        "entitlement_outbox",
        30,
        "PoisonTestEvent",
        1,
        tenantId,
      );
      expect(
        await worker.processOnce(async () => {
          return Promise.reject(new Error("poison"));
        }),
      ).toBe("dead_lettered");
      const [rows] = await connection.query<
        (RowDataPacket & { dead_lettered_at: Date | null })[]
      >(
        "SELECT dead_lettered_at FROM entitlement_outbox WHERE outbox_id = $1",
        [outboxId],
      );
      expect(rows[0]?.dead_lettered_at).not.toBeNull();
      expect(
        await worker.processOnce(async () => Promise.resolve(undefined)),
      ).toBe(false);
    } finally {
      await connection.end();
    }
  });

  it("renews the database lease while a handler is running", async () => {
    const connection = await createBillingConnection(
      assertDefined(databaseUrl),
    );
    const leaseConnection = await createBillingConnection(
      assertDefined(databaseUrl),
    );
    const outboxId = randomUUID();
    const tenantId = randomUUID();
    try {
      await connection.execute(
        `INSERT INTO entitlement_outbox (outbox_id, tenant_id, aggregate_type, aggregate_id, event_type, payload_json)
         VALUES ($1, $2, 'test', $3, 'SlowTestEvent', $4)`,
        [outboxId, tenantId, randomUUID(), JSON.stringify({ outboxId })],
      );
      const worker = new OutboxWorker(
        connection,
        "entitlement_outbox",
        1,
        "SlowTestEvent",
        10,
        tenantId,
        leaseConnection,
      );
      expect(
        await worker.processOnce(async () => {
          await new Promise((resolve) => setTimeout(resolve, 1_500));
        }),
      ).toBe("published");
    } finally {
      await leaseConnection.end();
      await connection.end();
    }
  });
});

integration.each(["entitlement_outbox", "payment_outbox"] as const)(
  "%s persisted payload failures",
  (table) => {
    describe.each([1, 2])("attempt budget %i", (maxAttempts) => {
      it.each([
        { shape: "array", json: "[]" },
        { shape: "number", json: "42" },
        { shape: "boolean", json: "true" },
        { shape: "string", json: '"corrupt"' },
        { shape: "JSON null", json: "null" },
      ])(
        "dead-letters $shape without invoking the handler",
        async ({ json }) => {
          const connection = await createBillingConnection(
            assertDefined(databaseUrl),
          );
          const tenantId = randomUUID();
          const outboxId = randomUUID();
          let handlerCalls = 0;
          const handler = async (): Promise<void> => {
            handlerCalls += 1;
            return Promise.resolve();
          };
          const worker = new OutboxWorker(
            connection,
            table,
            30,
            "InvalidPayload",
            maxAttempts,
            tenantId,
          );
          const readState = async () => {
            const [rows] = await connection.query<
              {
                attempts: number;
                lease_token: string | null;
                lease_until: Date | null;
                published_at: Date | null;
                dead_lettered_at: Date | null;
                next_attempt_at: Date;
                retry_is_future: boolean;
              }[]
            >(
              `SELECT attempts, lease_token, lease_until, published_at, dead_lettered_at,
                    next_attempt_at, next_attempt_at > clock_timestamp() AS retry_is_future
               FROM ${table} WHERE tenant_id = $1 AND outbox_id = $2`,
              [tenantId, outboxId],
            );
            return assertDefined(rows[0]);
          };
          try {
            await connection.execute(
              `INSERT INTO ${table} (outbox_id, tenant_id, aggregate_type, aggregate_id, event_type, payload_json)
             VALUES ($1, $2, 'test', $3, 'InvalidPayload', $4::jsonb)`,
              [outboxId, tenantId, randomUUID(), json],
            );
            if (maxAttempts === 2) {
              await expect(worker.processOnce(handler)).resolves.toBe(
                "retrying",
              );
              const retry = await readState();
              expect(retry).toMatchObject({
                attempts: 1,
                lease_token: null,
                lease_until: null,
                published_at: null,
                dead_lettered_at: null,
                retry_is_future: true,
              });
              await expect(worker.processOnce(handler)).resolves.toBe(false);
              expect((await readState()).attempts).toBe(1);
              // Advance only this fixture's schedule; no sleeps or shared queue reset.
              await connection.execute(
                `UPDATE ${table} SET next_attempt_at = clock_timestamp() - INTERVAL '1 second'
                WHERE tenant_id = $1 AND outbox_id = $2`,
                [tenantId, outboxId],
              );
            }
            await expect(worker.processOnce(handler)).resolves.toBe(
              "dead_lettered",
            );
            const terminal = await readState();
            expect(terminal).toMatchObject({
              attempts: maxAttempts,
              lease_token: null,
              lease_until: null,
              published_at: null,
            });
            expect(terminal.dead_lettered_at).toBeInstanceOf(Date);
            await expect(worker.processOnce(handler)).resolves.toBe(false);
            expect(await readState()).toEqual(terminal);
            expect(handlerCalls).toBe(0);
          } finally {
            await connection.end();
          }
        },
      );
    });

    it("still publishes a valid object without changing its payload", async () => {
      const connection = await createBillingConnection(
        assertDefined(databaseUrl),
      );
      const tenantId = randomUUID();
      const outboxId = randomUUID();
      const payload = {
        operation: "valid",
        nested: { values: [null, 42, true] },
      };
      let calls = 0;
      try {
        await connection.execute(
          `INSERT INTO ${table} (outbox_id, tenant_id, aggregate_type, aggregate_id, event_type, payload_json)
           VALUES ($1, $2, 'test', $3, 'ValidPayload', $4::jsonb)`,
          [outboxId, tenantId, randomUUID(), JSON.stringify(payload)],
        );
        const worker = new OutboxWorker(
          connection,
          table,
          30,
          "ValidPayload",
          1,
          tenantId,
        );
        await expect(
          worker.processOnce(async (event) => {
            calls += 1;
            expect(event).toEqual({
              outboxId,
              eventType: "ValidPayload",
              payload,
            });
            return Promise.resolve();
          }),
        ).resolves.toBe("published");
        await expect(
          worker.processOnce(async () => {
            calls += 1;
            return Promise.resolve();
          }),
        ).resolves.toBe(false);
        expect(calls).toBe(1);
      } finally {
        await connection.end();
      }
    });
  },
);
