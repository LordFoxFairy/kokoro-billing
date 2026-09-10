import { assertDefined } from "../assert-defined.js";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createBillingConnection } from "../../src/infrastructure/postgres/connection.js";
import {
  createPostgresUsagePricingAdminService,
  createPostgresUsagePricingService,
} from "../../src/infrastructure/postgres/create-postgres-services.js";

const databaseUrl = process.env.DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);

integration("admin usage pricing revisions", () => {
  it("publishes an immutable revision, is idempotent, and serves quotes", async () => {
    const connection = await createBillingConnection(
      assertDefined(databaseUrl),
    );
    const admin = createPostgresUsagePricingAdminService(connection);
    const pricing = createPostgresUsagePricingService(connection);
    const tenantId = randomUUID();
    const idempotencyKey = `pricing-publish-${randomUUID()}`;
    const input = {
      tenantId,
      operatorId: "operator-1",
      effectiveFrom: new Date(),
      reason: "initial target pricing",
      idempotencyKey,
      rates: [
        {
          featureKey: "chat",
          labelKey: "model-a",
          inputMicrosPerMillion: 2,
          outputMicrosPerMillion: 4,
          reservationMicros: 10,
        },
      ],
    } as const;
    try {
      const first = await admin.publish(input);
      const replay = await admin.publish(input);
      expect(replay).toEqual(first);
      const quote = await pricing.quote({
        tenantId,
        featureKey: "chat",
        labelKey: "model-a",
        inputTokens: 1_000_000,
        outputTokens: 0,
      });
      expect(quote.pricingRevisionId).toBe(first.pricingRevisionId);
      expect(quote.amountMicros).toBe(2);
      expect(quote.reservationMicros).toBe(10);
      await expect(
        admin.publish({
          ...input,
          rates: [{ ...input.rates[0], outputMicrosPerMillion: 5 }],
        }),
      ).rejects.toThrow("billing.idempotency_conflict");
    } finally {
      await connection.end();
    }
  });
});
