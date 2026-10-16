import { describe, expect, it, vi } from "vitest";
import { CreditRepository } from "../../src/modules/credit/credit.repository.js";
import {
  CreditEffects,
  CreditService,
} from "../../src/modules/credit/credit.service.js";
import type { TransactionService } from "../../src/database/transaction.service.js";
import type { AuditAppender } from "../../src/database/audit-appender.js";
import type { CommandReceiptRepository } from "../../src/database/command-receipt.repository.js";
const context = { tenantId: "tenant-a", subjectId: "subject-a" };
const row = () => ({
  id: "11111111-1111-4111-8111-111111111111",
  tenant_id: context.tenantId,
  subject_id: context.subjectId,
  status: "active",
  available_micros: 53n,
  held_micros: 7n,
  generation: 9n,
  created_at: new Date(0),
});
function fixture(existing: ReturnType<typeof row> | null) {
  const find = vi.fn(() => Promise.resolve(existing));
  const create = vi.fn(() =>
    Promise.resolve({
      ...row(),
      available_micros: 0n,
      held_micros: 0n,
      generation: 1n,
    }),
  );
  const query = vi.fn(() => Promise.resolve([]));
  const requireActiveTransaction = vi.fn(() => ({
    $queryRaw: query,
    billing_credit_account: { findFirst: find, create },
  }));
  const runRoot = vi.fn((_scope: unknown, callback: () => Promise<unknown>) =>
    callback(),
  );
  const transactions = {
    requireActiveTransaction,
    runRoot,
  } as unknown as TransactionService;
  const repository = new CreditRepository(transactions);
  const append = vi.fn(() => Promise.resolve("audit-id"));
  const effects = new CreditEffects(transactions, repository, {
    append,
  } as unknown as AuditAppender);
  const service = new CreditService(
    transactions,
    {} as CommandReceiptRepository,
    effects,
    repository,
  );
  return {
    find,
    create,
    query,
    requireActiveTransaction,
    runRoot,
    append,
    repository,
    service,
  };
}
describe("natural own account opening effects", () => {
  it("creates only default columns and audits once under authenticated service actor", async () => {
    const f = fixture(null);
    const account = await f.service.openMyAccount(context);
    expect(f.runRoot).toHaveBeenCalledWith(
      {
        tenantId: context.tenantId,
        actorId: "web-bff",
        operation: "credit.open_my_account",
        mode: "write",
      },
      expect.any(Function),
    );
    expect(f.query.mock.calls[0]).toEqual([
      expect.any(Array),
      "credit:subject:tenant-a:subject-a",
    ]);
    expect(f.find).toHaveBeenCalledWith({
      where: { tenant_id: context.tenantId, subject_id: context.subjectId },
    });
    expect(f.create).toHaveBeenCalledWith({
      data: {
        id: expect.any(String) as unknown,
        tenant_id: context.tenantId,
        subject_id: context.subjectId,
      },
    });
    expect(account.availableMicros).toBe(0n);
    expect(f.append).toHaveBeenCalledTimes(1);
    expect(f.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "credit.account_open",
        subjectId: context.subjectId,
        resourceId: account.id,
        payload: {},
      }),
    );
  });
  it("keeps an existing nonzero account and generation untouched without a second audit", async () => {
    const original = row();
    const before = structuredClone(original);
    const f = fixture(original);
    const a = await f.service.openMyAccount(context);
    const b = await f.service.openMyAccount(context);
    expect(a).toEqual(b);
    expect(a.availableMicros).toBe(53n);
    expect(original).toEqual(before);
    expect(f.create).not.toHaveBeenCalled();
    expect(f.append).not.toHaveBeenCalled();
  });
  it("waits for the shared grant subject lock before finding or creating", async () => {
    const f = fixture(null);
    let release!: () => void;
    f.query.mockImplementationOnce(
      () =>
        new Promise<never[]>((resolve) => {
          release = () => resolve([]);
        }),
    );
    const pending = f.service.openMyAccount(context);
    await Promise.resolve();
    expect(f.find).not.toHaveBeenCalled();
    release();
    await pending;
    expect(f.find).toHaveBeenCalledTimes(1);
  });
  it("propagates audit failure rather than returning a success", async () => {
    const f = fixture(null);
    const failure = new Error("audit rejected");
    f.append.mockRejectedValueOnce(failure);
    await expect(f.service.openMyAccount(context)).rejects.toBe(failure);
  });
  it("rejects disabled and corrupt facts without audit or create", async () => {
    for (const bad of [
      { ...row(), status: "disabled" },
      { ...row(), tenant_id: "foreign" },
      { ...row(), available_micros: -1n },
      { ...row(), generation: 0n },
    ]) {
      const f = fixture(bad);
      await expect(f.service.openMyAccount(context)).rejects.toMatchObject({
        code:
          bad.status === "disabled"
            ? "CREDIT_ACCOUNT_DISABLED"
            : "CREDIT_READ_CORRUPT",
      });
      expect(f.create).not.toHaveBeenCalled();
      expect(f.append).not.toHaveBeenCalled();
    }
  });
});
