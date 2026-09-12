import { describe, expect, it } from "vitest";
import {
  preserveTransactionFailure,
  TransactionContextError,
} from "../../src/database/transaction.error.js";
import {
  defaultTransactionOptions,
  maximumTransactionTimeoutMs,
  transactionModes,
} from "../../src/database/transaction.types.js";

describe("transaction public facts", () => {
  it("keeps the supported modes and production budgets immutable", () => {
    expect(transactionModes).toEqual(["write", "readOnlySnapshot"]);
    expect(defaultTransactionOptions).toEqual({
      maxWaitMs: 1_000,
      timeoutMs: 10_000,
      statementTimeoutMs: 8_000,
      lockTimeoutMs: 1_000,
      idleInTransactionTimeoutMs: 10_000,
    });
    expect(Object.isFrozen(defaultTransactionOptions)).toBe(true);
  });

  it("rejects values above the Node timer and PostgreSQL integer range", () => {
    expect(maximumTransactionTimeoutMs).toBe(2_147_483_647);
  });

  it("preserves callback primary through TransactionService.run when rollback reports a secondary", async () => {
    const primary = Number.NaN;
    const secondary = new Error("driver rollback failed");
    const transactionClient = {
      $executeRaw: () => Promise.resolve(0),
      $queryRaw: () => Promise.resolve([]),
    };
    const fakeClient = {
      $extends: () => ({
        $transaction: async (
          callback: (client: typeof transactionClient) => Promise<unknown>,
        ) => {
          try {
            await callback(transactionClient);
          } catch (error) {
            expect(Object.is(error, primary)).toBe(true);
            throw secondary;
          }
        },
      }),
    };
    const { TransactionService } =
      await import("../../src/database/transaction.service.js");
    const service = new TransactionService(fakeClient as never);
    await expect(
      service.run(
        {
          tenantId: "tenant-a",
          actorId: "actor-a",
          operation: "unit",
          mode: "write",
        },
        // Falsey thrown values are an intentional compatibility boundary.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        () => Promise.reject(primary),
      ),
    ).rejects.toMatchObject({ cause: primary, errors: [primary, secondary] });
  });

  it.each([undefined, null, false, 0, Number.NaN])(
    "preserves the exact primary cause %s when cleanup also fails",
    (primary) => {
      const secondary = new Error("cleanup");
      const error = preserveTransactionFailure(primary, secondary);
      expect(Object.is(error.cause, primary)).toBe(true);
      expect(error.errors).toHaveLength(2);
      expect(Object.is(error.errors[0], primary)).toBe(true);
      expect(error.errors[1]).toBe(secondary);
    },
  );

  it("preserves a structured context error and its cause", () => {
    const cause = new Error("primary");
    const error = new TransactionContextError(
      "TRANSACTION_CONTEXT_CLOSED",
      "closed",
      { cause },
    );
    expect(error).toMatchObject({
      name: "TransactionContextError",
      code: "TRANSACTION_CONTEXT_CLOSED",
      cause,
    });
  });
});
