import { assertDefined } from "../assert-defined.js";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createBillingConnection } from "../../src/infrastructure/postgres/connection.js";
import type { RowDataPacket } from "../../src/infrastructure/postgres/connection.js";
import { createPostgresCatalogAdminService } from "../../src/infrastructure/postgres/create-postgres-services.js";

const databaseUrl = process.env.DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);

integration("catalog admin revisions", () => {
  it("publishes a new immutable revision and records operator audit", async () => {
    const connection = await createBillingConnection(
      assertDefined(databaseUrl),
    );
    const tenantId = randomUUID();
    const service = createPostgresCatalogAdminService(connection);
    try {
      const first = await service.publishPlan({
        tenantId,
        operatorId: "operator-1",
        idempotencyKey: "catalog-1",
        offerKey: "pro",
        name: "Pro",
        currency: "USD",
        amountMinor: 1999,
        creditMicros: 1_000_000,
        billingInterval: "month",
        reason: "initial publish",
      });
      const replay = await service.publishPlan({
        tenantId,
        operatorId: "operator-1",
        idempotencyKey: "catalog-1",
        offerKey: "pro",
        name: "Pro",
        currency: "USD",
        amountMinor: 1999,
        creditMicros: 1_000_000,
        billingInterval: "month",
        reason: "initial publish",
      });
      const second = await service.publishPlan({
        tenantId,
        operatorId: "operator-1",
        idempotencyKey: "catalog-2",
        offerKey: "pro",
        name: "Pro+",
        currency: "USD",
        amountMinor: 2999,
        creditMicros: 2_000_000,
        billingInterval: "month",
        reason: "price revision",
      });
      expect(first.id).not.toBe(second.id);
      expect(replay).toEqual(first);
      const [rows] = await connection.query<
        (RowDataPacket & { revision: number; status: string })[]
      >(
        `SELECT revision, status FROM entitlement_offer_revision WHERE tenant_id = $1 ORDER BY revision`,
        [tenantId],
      );
      expect(rows).toEqual([
        { revision: 1, status: "published" },
        { revision: 2, status: "published" },
      ]);
      const [audit] = await connection.query<
        (RowDataPacket & { action: string })[]
      >(
        `SELECT action FROM entitlement_audit_event WHERE tenant_id = $1 ORDER BY created_at`,
        [tenantId],
      );
      expect(audit.map((row) => row.action)).toEqual([
        "catalog.plan.publish",
        "catalog.plan.publish",
      ]);
    } finally {
      await connection.execute(
        `DELETE FROM entitlement_command_receipt WHERE tenant_id = $1`,
        [tenantId],
      );
      await connection.execute(
        "DELETE FROM entitlement_audit_event WHERE tenant_id = $1",
        [tenantId],
      );
      await connection.execute(
        "DELETE FROM entitlement_offer_revision WHERE tenant_id = $1",
        [tenantId],
      );
      await connection.execute(
        "DELETE FROM entitlement_offer WHERE tenant_id = $1",
        [tenantId],
      );
      await connection.end();
    }
  });
});
