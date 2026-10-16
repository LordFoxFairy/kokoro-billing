import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createBillingConnection } from "../../src/infrastructure/postgres/connection.js";
import { createPostgresBillingSettlementService } from "../../src/infrastructure/postgres/create-postgres-services.js";
import { PersistedDataInvariantError } from "../../src/infrastructure/postgres/json.js";

const databaseUrl = process.env.DATABASE_URL;
const integration = describe.skipIf(databaseUrl === undefined);

const requiredDatabaseUrl = (): string => {
  if (databaseUrl === undefined) throw new Error("DATABASE_URL is required");
  return databaseUrl;
};

integration("durable result service invariants", () => {
  it("rejects a corrupt PostgreSQL receipt result at the durable service boundary", async () => {
    const connection = await createBillingConnection(requiredDatabaseUrl());
    const settlement = createPostgresBillingSettlementService(connection);
    const tenantId = randomUUID();
    const idempotencyKey = `settlement-${randomUUID()}`;
    const input = {
      settlementId: randomUUID(),
      tenantId,
      idempotencyKey,
      provider: "stripe",
      externalPaymentRef: `payment-${randomUUID()}`,
      amountMinor: 1000,
      currency: "USD",
    };
    try {
      expect(await settlement.recordSettlement(input)).toEqual({
        settlementId: input.settlementId,
        accepted: true,
      });
      await connection.execute(
        `UPDATE payment_command_receipt SET result_json = '{"accepted":false}'::jsonb
          WHERE tenant_id = $1 AND command_name = 'payment.settlement.accept' AND idempotency_key = $2`,
        [tenantId, idempotencyKey],
      );

      await expect(settlement.recordSettlement(input)).rejects.toBeInstanceOf(
        PersistedDataInvariantError,
      );
    } finally {
      await connection.end();
    }
  });
});
