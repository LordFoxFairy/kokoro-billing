import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AuditAppender } from "../../src/database/audit-appender.js";
import { TransactionService } from "../../src/database/transaction.service.js";
import { assertDefined } from "../assert-defined.js";
import {
  createPrismaDatabaseFixture,
  type PrismaDatabaseFixture,
} from "./prisma-database.fixture.js";
const adminUrl = process.env.SCHEMA_ADMIN_URL;
describe.skipIf(adminUrl === undefined)("audit appender", () => {
  let fixture: PrismaDatabaseFixture | undefined;
  beforeEach(async () => {
    fixture = await createPrismaDatabaseFixture(assertDefined(adminUrl));
  });
  afterEach(async () => {
    await fixture?.close();
    fixture = undefined;
  });
  test("takes tenant and actor from the active transaction and rolls back atomically", async () => {
    const tx = new TransactionService(assertDefined(fixture).client);
    const audit = new AuditAppender(tx);
    const scope = {
      tenantId: "tenant",
      actorId: "trusted-actor",
      operation: "audit",
      mode: "write" as const,
    };
    await expect(
      tx.runRoot(scope, async () => {
        await audit.append({
          tenantId: "tenant",
          action: "credit.test",
          resourceType: "account",
          reason: "test",
          payload: { safe: true },
        });
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(
      await assertDefined(fixture).client.billing_audit_event.count(),
    ).toBe(0);
    await tx.runRoot(scope, () =>
      audit.append({
        tenantId: "tenant",
        action: "credit.test",
        resourceType: "account",
        reason: "test",
        payload: {},
      }),
    );
    expect(
      await assertDefined(fixture).client.billing_audit_event.findFirst(),
    ).toMatchObject({ tenant_id: "tenant", operator_id: "trusted-actor" });
  });
});
