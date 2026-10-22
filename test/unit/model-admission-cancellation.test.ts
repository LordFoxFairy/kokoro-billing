import { describe, expect, test, vi } from "vitest";
import type { TransactionService } from "../../src/database/transaction.service.js";
import { ModelAdmissionService } from "../../src/modules/metering/model-admission.service.js";
// Only the awaited miss boundary is doubled. No SQL, authentication or committed funds are claimed here.
describe("model admission cancellation after awaited recovery or hidden reads", () => {
  test.each(["read", "create"] as const)(
    "%s does not turn an aborted miss into a normal result or new peer work",
    async (operation) => {
      const controller = new AbortController();
      const abortMiss = () => {
        controller.abort();
        return Promise.resolve(null);
      };
      const transactions = {
        runRoot: async (_scope: unknown, body: () => Promise<unknown>) =>
          body(),
        requireActiveTransaction: () => ({
          billing_admission: { findFirst: abortMiss },
        }),
      } as unknown as TransactionService;
      const readPrepared = vi.fn();
      const service = new ModelAdmissionService(
        transactions,
        { recover: abortMiss } as never,
        undefined as never,
        undefined as never,
        undefined as never,
        { readPrepared },
        undefined as never,
      );
      const context = {
        tenantId: "tenant-a",
        actorId: "actor-a",
        requestId: "cancel-boundary",
        signal: controller.signal,
      };
      const id = "11111111-1111-4111-8111-111111111111";
      const call =
        operation === "read"
          ? service.read(context, id)
          : service.create(
              context,
              {
                runId: "run-a",
                attemptId: id,
                requestRef: "request-a",
                attemptBindingDigest: "a".repeat(64),
                plannedDigest: "b".repeat(64),
                finalRequestDigest: "c".repeat(64),
                idempotencyKey: "cancel-command-key",
              },
              "unused-consumption",
            );
      await expect(call).rejects.toMatchObject({ code: "ABORTED" });
      expect(readPrepared).not.toHaveBeenCalled();
    },
  );
});
