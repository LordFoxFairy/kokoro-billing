import { assertDefined } from "../assert-defined.js";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createBillingConnection } from "../../src/infrastructure/postgres/connection.js";
import { createPostgresSubscriptionQueryService } from "../../src/infrastructure/postgres/create-postgres-services.js";

const databaseUrl = process.env.DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);

integration("subscription query pagination", () => {
  it("uses a limit-plus-one keyset cursor bound to tenant and subject", async () => {
    const connection = await createBillingConnection(
      assertDefined(databaseUrl),
    );
    const tenantId = randomUUID();
    const subjectId = randomUUID();
    const otherSubjectId = randomUUID();
    const terms = [
      {
        id: randomUUID(),
        key: "latest",
        start: "2026-03-01T00:00:00.000Z",
        end: "2026-04-01T00:00:00.000Z",
      },
      {
        id: randomUUID(),
        key: "middle",
        start: "2026-02-01T00:00:00.000Z",
        end: "2026-03-01T00:00:00.000Z",
      },
      {
        id: randomUUID(),
        key: "oldest",
        start: "2026-01-01T00:00:00.000Z",
        end: "2026-02-01T00:00:00.000Z",
      },
    ];
    try {
      for (const term of terms) {
        await connection.execute(
          `INSERT INTO entitlement_subscription_term
            (term_id, tenant_id, subject_id, source_period_id, program_key, period_start, period_end)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            term.id,
            tenantId,
            subjectId,
            randomUUID(),
            term.key,
            new Date(term.start),
            new Date(term.end),
          ],
        );
      }

      const service = createPostgresSubscriptionQueryService(connection);
      const first = await service.listForSubject(tenantId, subjectId, 2);
      expect(first.items.map((item) => item.planKey)).toEqual([
        "latest",
        "middle",
      ]);
      expect(first.nextCursor).toEqual(expect.any(String));
      await expect(
        service.listForSubject(tenantId, otherSubjectId, 2, first.nextCursor),
      ).rejects.toThrow("billing.invalid_cursor");

      const second = await service.listForSubject(
        tenantId,
        subjectId,
        2,
        first.nextCursor,
      );
      expect(second.items.map((item) => item.planKey)).toEqual(["oldest"]);
      expect(second.nextCursor).toBeUndefined();
    } finally {
      await connection.execute(
        "DELETE FROM entitlement_subscription_term WHERE tenant_id = $1",
        [tenantId],
      );
      await connection.end();
    }
  });

  it("does not emit a cursor for an exact final page", async () => {
    const connection = await createBillingConnection(
      assertDefined(databaseUrl),
    );
    const tenantId = randomUUID();
    const subjectId = randomUUID();
    try {
      for (const month of [1, 2]) {
        await connection.execute(
          `INSERT INTO entitlement_subscription_term
            (term_id, tenant_id, subject_id, source_period_id, program_key, period_start, period_end)
           VALUES ($1, $2, $3, $4, 'exact', $5, $6)`,
          [
            randomUUID(),
            tenantId,
            subjectId,
            randomUUID(),
            new Date(Date.UTC(2026, month - 1, 1)),
            new Date(Date.UTC(2026, month, 1)),
          ],
        );
      }
      const page = await createPostgresSubscriptionQueryService(
        connection,
      ).listForSubject(tenantId, subjectId, 2);
      expect(page.items).toHaveLength(2);
      expect(page.nextCursor).toBeUndefined();
    } finally {
      await connection.execute(
        "DELETE FROM entitlement_subscription_term WHERE tenant_id = $1",
        [tenantId],
      );
      await connection.end();
    }
  });
});
