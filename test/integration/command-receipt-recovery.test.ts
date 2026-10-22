import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { CommandReceiptRepository } from "../../src/database/command-receipt.repository.js";
import { TransactionService } from "../../src/database/transaction.service.js";
import { assertDefined } from "../assert-defined.js";
import {
  createPrismaDatabaseFixture,
  type PrismaDatabaseFixture,
} from "./prisma-database.fixture.js";
const adminUrl = process.env.SCHEMA_ADMIN_URL;
describe.skipIf(adminUrl === undefined)(
  "permanent command recovery before external I/O",
  () => {
    let fixture: PrismaDatabaseFixture | undefined;
    beforeEach(async () => {
      fixture = await createPrismaDatabaseFixture(assertDefined(adminUrl));
    });
    afterEach(async () => {
      await fixture?.close();
      fixture = undefined;
    });
    const setup = () => {
      const tx = new TransactionService(assertDefined(fixture).client);
      const receipts = new CommandReceiptRepository(tx);
      const scope = {
        tenantId: "tenant",
        actorId: "actor",
        operation: "recovery",
        mode: "write" as const,
      };
      const request = (
        key = "key-original",
        identity = "attempt-original",
        digest = "a".repeat(64),
      ) => ({
        tenantId: "tenant",
        namespace: "admission" as const,
        commandName: "model.admit",
        commandIdentity: identity,
        idempotencyKey: key,
        requestSchemaVersion: 1,
        payloadDigest: digest,
      });
      const codec = {
        schemaVersion: 1,
        encode: (value: { admission: string }) => value,
        decode: (value: unknown) => {
          if (
            value === null ||
            typeof value !== "object" ||
            !("admission" in value) ||
            typeof value.admission !== "string"
          )
            throw new TypeError();
          return { admission: value.admission };
        },
      };
      return { tx, receipts, scope, request, codec };
    };
    test("a miss has no durable processing receipt or key binding", async () => {
      const { tx, receipts, scope, request, codec } = setup();
      expect(
        await tx.runRoot(scope, () => receipts.recover(request(), codec)),
      ).toBeNull();
      expect(
        await assertDefined(fixture).client.billing_command_receipt.count(),
      ).toBe(0);
      expect(
        await assertDefined(fixture).client.billing_command_key_binding.count(),
      ).toBe(0);
    });
    test("recovers the original result before new evidence and permanently binds a replacement key", async () => {
      const { tx, receipts, scope, request, codec } = setup();
      const original = await tx.runRoot(scope, () =>
        receipts.execute(request(), codec, () =>
          Promise.resolve({ admission: "admission-original" }),
        ),
      );
      expect(
        await tx.runRoot(scope, () =>
          receipts.recover(request("replacement-key"), codec),
        ),
      ).toEqual({ ...original, replayed: true });
      await expect(
        tx.runRoot(scope, () =>
          receipts.recover(
            request("replacement-key", "different-attempt"),
            codec,
          ),
        ),
      ).rejects.toMatchObject({ code: "COMMAND_IDEMPOTENCY_CONFLICT" });
      await expect(
        tx.runRoot(scope, () =>
          receipts.recover(
            request("third-key", "attempt-original", "b".repeat(64)),
            codec,
          ),
        ),
      ).rejects.toMatchObject({ code: "COMMAND_IDEMPOTENCY_CONFLICT" });
      expect(
        await assertDefined(fixture).client.billing_command_receipt.count(),
      ).toBe(1);
      expect(
        await assertDefined(fixture).client.billing_command_key_binding.count(),
      ).toBe(2);
    });
    test("waits for an in-flight original command and observes its committed result without duplicate effect", async () => {
      const { tx, receipts, scope, request, codec } = setup();
      let entered!: () => void;
      let release!: () => void;
      const started = new Promise<void>((r) => {
        entered = r;
      });
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const original = tx.runRoot(scope, () =>
        receipts.execute(request(), codec, async () => {
          entered();
          await gate;
          return { admission: "original" };
        }),
      );
      await started;
      let recovered = false;
      const pending = tx
        .runRoot(scope, () => receipts.recover(request("recovery-key"), codec))
        .then((r) => {
          recovered = true;
          return r;
        });
      let beforeRelease;
      try {
        await new Promise((r) => setTimeout(r, 30));
        beforeRelease = recovered;
      } finally {
        release();
      }
      const [first, restored] = await Promise.all([original, pending]);
      expect(beforeRelease).toBe(false);
      expect(restored).toEqual({ ...first, replayed: true });
      expect(
        await assertDefined(fixture).client.billing_command_receipt.count(),
      ).toBe(1);
    });
    test("a caller rollback also rolls back a new replay key", async () => {
      const { tx, receipts, scope, request, codec } = setup();
      await tx.runRoot(scope, () =>
        receipts.execute(request(), codec, () =>
          Promise.resolve({ admission: "original" }),
        ),
      );
      await expect(
        tx.runRoot(scope, async () => {
          await receipts.recover(request("rolled-back-key"), codec);
          throw new Error("rollback recovery");
        }),
      ).rejects.toThrow("rollback recovery");
      expect(
        await assertDefined(fixture).client.billing_command_key_binding.count(),
      ).toBe(1);
      expect(
        await tx.runRoot(scope, () =>
          receipts.recover(request("rolled-back-key", "different"), codec),
        ),
      ).toBeNull();
    });
    test("corrupt results fail closed and cannot bind a fresh key", async () => {
      const { tx, receipts, scope, request, codec } = setup();
      const first = await tx.runRoot(scope, () =>
        receipts.execute(request(), codec, () =>
          Promise.resolve({ admission: "original" }),
        ),
      );
      await assertDefined(fixture).client.billing_command_receipt.update({
        where: { id: first.receiptId },
        data: { result_json: { wrong: true } },
      });
      await expect(
        tx.runRoot(scope, () => receipts.recover(request("new-key"), codec)),
      ).rejects.toMatchObject({ code: "COMMAND_RECEIPT_CORRUPT" });
      expect(
        await assertDefined(fixture).client.billing_command_key_binding.count(),
      ).toBe(1);
    });
    test("same opaque identities in another tenant remain a miss", async () => {
      const { tx, receipts, scope, request, codec } = setup();
      await tx.runRoot(scope, () =>
        receipts.execute(request(), codec, () =>
          Promise.resolve({ admission: "original" }),
        ),
      );
      expect(
        await tx.runRoot({ ...scope, tenantId: "other" }, () =>
          receipts.recover({ ...request(), tenantId: "other" }, codec),
        ),
      ).toBeNull();
    });
  },
);
