import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { OutboxRepository } from "../../src/database/outbox.repository.js";
import { AuditAppender } from "../../src/database/audit-appender.js";
import { TransactionService } from "../../src/database/transaction.service.js";
import { assertDefined } from "../assert-defined.js";
import {
  createPrismaDatabaseFixture,
  type PrismaDatabaseFixture,
} from "./prisma-database.fixture.js";
const adminUrl = process.env.SCHEMA_ADMIN_URL;
describe.skipIf(adminUrl === undefined)("outbox repository", () => {
  let fixture: PrismaDatabaseFixture | undefined;
  beforeEach(async () => {
    fixture = await createPrismaDatabaseFixture(assertDefined(adminUrl));
  });
  afterEach(async () => {
    await fixture?.close();
    fixture = undefined;
  });
  const scope = {
    tenantId: "tenant",
    actorId: "worker",
    operation: "outbox",
    mode: "write" as const,
  };
  test("claims exclusively and fences expired and stale lease tokens with database time", async () => {
    const tx = new TransactionService(assertDefined(fixture).client);
    const outbox = new OutboxRepository(tx, new AuditAppender(tx));
    let id = "";
    await tx.runRoot(scope, async () => {
      id = await outbox.enqueue({
        tenantId: "tenant",
        namespace: "payment",
        aggregateType: "refund",
        aggregateId: "00000000-0000-4000-8000-000000000001",
        eventType: "RefundCreditEffectRequested",
        eventIdentity: "refund:1",
        payloadSchemaVersion: 1,
        payloadDigest: "a".repeat(64),
        payload: { refund: 1 },
      });
    });
    const first = await tx.runRoot(scope, () =>
      outbox.claimNext({
        tenantId: "tenant",
        namespace: "payment",
        eventTypes: ["RefundCreditEffectRequested"],
        leaseMs: 50,
        limit: 1,
      }),
    );
    expect(first).toHaveLength(1);
    expect(
      await tx.runRoot(scope, () =>
        outbox.claimNext({
          tenantId: "tenant",
          namespace: "payment",
          eventTypes: ["RefundCreditEffectRequested"],
          leaseMs: 50,
          limit: 1,
        }),
      ),
    ).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const second = await tx.runRoot(scope, () =>
      outbox.claimNext({
        tenantId: "tenant",
        namespace: "payment",
        eventTypes: ["RefundCreditEffectRequested"],
        leaseMs: 500,
        limit: 1,
      }),
    );
    expect(second).toHaveLength(1);
    expect(
      await tx.runRoot(scope, () =>
        outbox.complete({
          tenantId: "tenant",
          namespace: "payment",
          id,
          leaseToken: assertDefined(first[0]).leaseToken,
        }),
      ),
    ).toBe(false);
    expect(
      await tx.runRoot(scope, () =>
        outbox.complete({
          tenantId: "tenant",
          namespace: "payment",
          id,
          leaseToken: assertDefined(second[0]).leaseToken,
        }),
      ),
    ).toBe(true);
  });

  test("retries, dead-letters, and requeues with generation CAS and audit", async () => {
    const tx = new TransactionService(assertDefined(fixture).client);
    const audit = new AuditAppender(tx);
    const outbox = new OutboxRepository(tx, audit);
    let id = "";
    await tx.runRoot(scope, async () => {
      id = await outbox.enqueue({
        tenantId: "tenant",
        namespace: "payment",
        aggregateType: "subscription",
        aggregateId: "00000000-0000-4000-8000-000000000002",
        eventType: "SubscriptionCreditGrantRequested",
        eventIdentity: "period:1",
        payloadSchemaVersion: 1,
        payloadDigest: "c".repeat(64),
        payload: {},
      });
    });
    const claimed = assertDefined(
      (
        await tx.runRoot(scope, () =>
          outbox.claimNext({
            tenantId: "tenant",
            namespace: "payment",
            eventTypes: ["SubscriptionCreditGrantRequested"],
            leaseMs: 500,
            limit: 1,
          }),
        )
      )[0],
    );
    expect(
      await tx.runRoot(scope, () =>
        outbox.retry(
          {
            tenantId: "tenant",
            namespace: "payment",
            id,
            leaseToken: claimed.leaseToken,
          },
          "temporary",
          1,
        ),
      ),
    ).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const again = assertDefined(
      (
        await tx.runRoot(scope, () =>
          outbox.claimNext({
            tenantId: "tenant",
            namespace: "payment",
            eventTypes: ["SubscriptionCreditGrantRequested"],
            leaseMs: 500,
            limit: 1,
          }),
        )
      )[0],
    );
    expect(
      await tx.runRoot(scope, () =>
        outbox.deadLetter(
          {
            tenantId: "tenant",
            namespace: "payment",
            id,
            leaseToken: again.leaseToken,
          },
          "poison",
        ),
      ),
    ).toBe(true);
    expect(
      await tx.runRoot(scope, () =>
        outbox.requeue({
          tenantId: "tenant",
          namespace: "payment",
          id,
          expectedGeneration: 0,
          reason: "operator retry",
        }),
      ),
    ).toBe(true);
    const afterRequeue = assertDefined(
      (
        await tx.runRoot(scope, () =>
          outbox.claimNext({
            tenantId: "tenant",
            namespace: "payment",
            eventTypes: ["SubscriptionCreditGrantRequested"],
            leaseMs: 500,
            limit: 1,
          }),
        )
      )[0],
    );
    expect(afterRequeue.attempts).toBe(1);
    expect(
      await tx.runRoot(scope, () =>
        outbox.requeue({
          tenantId: "tenant",
          namespace: "payment",
          id,
          expectedGeneration: 0,
          reason: "stale",
        }),
      ),
    ).toBe(false);
    expect(
      await assertDefined(fixture).client.billing_audit_event.count(),
    ).toBe(1);
  });

  test("rechecks database time after waiting for a row lock", async () => {
    const tx = new TransactionService(assertDefined(fixture).client);
    const outbox = new OutboxRepository(tx, new AuditAppender(tx));
    let id = "";
    await tx.runRoot(scope, async () => {
      id = await outbox.enqueue({
        tenantId: "tenant",
        namespace: "payment",
        aggregateType: "refund",
        aggregateId: "00000000-0000-4000-8000-000000000003",
        eventType: "RefundCreditEffectRequested",
        eventIdentity: "refund:locked",
        payloadSchemaVersion: 1,
        payloadDigest: "d".repeat(64),
        payload: {},
      });
    });
    const lease = assertDefined(
      (
        await tx.runRoot(scope, () =>
          outbox.claimNext({
            tenantId: "tenant",
            namespace: "payment",
            eventTypes: ["RefundCreditEffectRequested"],
            leaseMs: 80,
            limit: 1,
          }),
        )
      )[0],
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = assertDefined(fixture).client.$transaction(
      async (client) => {
        await client.$queryRaw`SELECT id FROM billing_outbox WHERE id = ${id}::uuid FOR UPDATE`;
        locked();
        await gate;
      },
    );
    try {
      await ready;
      const late = tx.runRoot(scope, () =>
        outbox.complete({
          tenantId: "tenant",
          namespace: "payment",
          id,
          leaseToken: lease.leaseToken,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 110));
      release();
      expect(await late).toBe(false);
    } finally {
      release();
      await holder;
    }
  });
});
