import { describe, expect, it, vi } from "vitest";
import { CatalogRepository } from "../../src/modules/commerce/catalog.repository.js";
import { CatalogService } from "../../src/modules/commerce/catalog.service.js";
import { decodeCatalogCursor } from "../../src/modules/commerce/catalog.query.js";
import type { TransactionService } from "../../src/database/transaction.service.js";
const first = {
  id: "11111111-1111-4111-8111-111111111111",
  offer_key: "plan-a",
  revision: 4,
  name: "Plan A",
  amount_minor: 9007199254740993n,
  currency_code: "USD",
  credit_micros: 9223372036854775807n,
  billing_interval: "month",
};
function fixture(rows: unknown[], corrupt: unknown[] = []) {
  const query = vi
    .fn()
    .mockResolvedValueOnce([{ instant: new Date("2026-01-01T00:00:00Z") }])
    .mockResolvedValueOnce(corrupt)
    .mockResolvedValueOnce(rows);
  const active = vi.fn(() => ({ $queryRaw: query }));
  const runRoot = vi.fn((_scope: unknown, callback: () => Promise<unknown>) =>
    callback(),
  );
  const transactions = {
    requireActiveTransaction: active,
    runRoot,
  } as unknown as TransactionService;
  const repository = new CatalogRepository(transactions);
  return {
    query,
    active,
    runRoot,
    repository,
    service: new CatalogService(transactions, repository),
  };
}
describe("Catalog canonical row mapping and transaction scope", () => {
  it("uses the authenticated actor and one read-only snapshot, preserving exact int64 decimals and stable next tuple", async () => {
    const f = fixture([
      first,
      {
        ...first,
        id: "22222222-2222-4222-8222-222222222222",
        offer_key: "plan-b",
      },
    ]);
    const result = await f.service.list(
      { tenantId: "tenant-a", actorId: "web-bff" },
      { limit: 1 },
    );
    expect(f.runRoot).toHaveBeenCalledWith(
      {
        tenantId: "tenant-a",
        actorId: "web-bff",
        operation: "commerce.catalog.list",
        mode: "readOnlySnapshot",
      },
      expect.any(Function),
    );
    expect(f.active).toHaveBeenCalledWith("tenant-a", "readOnlySnapshot");
    expect(result.data.items).toEqual([
      {
        offer_revision_id: first.id,
        offer_key: "plan-a",
        name: "Plan A",
        amount_minor: "9007199254740993",
        currency_code: "USD",
        credit_micros: "9223372036854775807",
        billing_interval: "month",
      },
    ]);
    const nextCursor = result.data.page.next_cursor;
    if (!nextCursor) throw new Error("Missing fixture cursor");
    expect(decodeCatalogCursor(nextCursor, "tenant-a")).toMatchObject({
      offerKey: "plan-a",
      revision: 4,
      revisionId: first.id,
    });
  });
  it("fails closed before the page query on a no-FK parent integrity violation", async () => {
    const f = fixture([], [{ id: first.id }]);
    await expect(
      f.repository.list("tenant-a", { limit: 50 }),
    ).rejects.toThrow();
    expect(f.query).toHaveBeenCalledTimes(2);
  });
  it.each([
    { amount_minor: 9007199254740992 },
    { amount_minor: 0n },
    { credit_micros: -1n },
    { credit_micros: 9223372036854775808n },
    { currency_code: "usd" },
    { billing_interval: "week" },
    { revision: 0 },
    { name: "" },
    { name: "\ud800" },
    { offer_key: "" },
    { id: "not-a-uuid" },
  ])(
    "rejects corrupt rows without inventing defaults case %#",
    async (patch) => {
      const f = fixture([{ ...first, ...patch }]);
      await expect(
        f.repository.list("tenant-a", { limit: 50 }),
      ).rejects.toThrow();
    },
  );
});
