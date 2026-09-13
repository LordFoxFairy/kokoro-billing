import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { CommandReceiptRepository } from "../../src/database/command-receipt.repository.js";
import { TransactionService } from "../../src/database/transaction.service.js";
import { AuditAppender } from "../../src/database/audit-appender.js";
import { OutboxRepository } from "../../src/database/outbox.repository.js";
import { assertDefined } from "../assert-defined.js";
import {
  createPrismaDatabaseFixture,
  type PrismaDatabaseFixture,
} from "./prisma-database.fixture.js";

const adminUrl = process.env.SCHEMA_ADMIN_URL;
describe.skipIf(adminUrl === undefined)("command receipt repository", () => {
  let fixture: PrismaDatabaseFixture | undefined;
  beforeEach(async () => {
    fixture = await createPrismaDatabaseFixture(assertDefined(adminUrl));
  });
  afterEach(async () => {
    await fixture?.close();
    fixture = undefined;
  });

  test("persists every replay key and prevents key2 from executing identity2", async () => {
    const tx = new TransactionService(assertDefined(fixture).client);
    const receipts = new CommandReceiptRepository(tx);
    const scope = {
      tenantId: "tenant",
      actorId: "actor",
      operation: "command",
      mode: "write" as const,
    };
    const codec = {
      schemaVersion: 1,
      encode: (value: { n: number }) => value,
      decode: (value: unknown) => value as { n: number },
    };
    let effects = 0;
    const request = (key: string, identity: string) => ({
      tenantId: "tenant",
      namespace: "general" as const,
      commandName: "grant",
      commandIdentity: identity,
      idempotencyKey: key,
      requestSchemaVersion: 1,
      payloadDigest: "a".repeat(64),
    });
    const invoke = (key: string, identity: string) =>
      tx.runRoot(scope, () =>
        receipts.execute(request(key, identity), codec, () =>
          Promise.resolve({ n: ++effects }),
        ),
      );
    expect(await invoke("key1", "id1")).toMatchObject({
      replayed: false,
      value: { n: 1 },
    });
    expect(await invoke("key2", "id1")).toMatchObject({
      replayed: true,
      value: { n: 1 },
    });
    await expect(invoke("key2", "id2")).rejects.toMatchObject({
      code: "COMMAND_IDEMPOTENCY_CONFLICT",
    });
    expect(effects).toBe(1);
    expect(
      await assertDefined(fixture).client.billing_command_receipt.count(),
    ).toBe(1);
    expect(
      await assertDefined(fixture).client.billing_command_key_binding.count(),
    ).toBe(2);
  });

  test("serializes different keys for one identity into one effect", async () => {
    const tx = new TransactionService(assertDefined(fixture).client);
    const receipts = new CommandReceiptRepository(tx);
    const scope = {
      tenantId: "tenant",
      actorId: "actor",
      operation: "concurrent",
      mode: "write" as const,
    };
    let effects = 0;
    const invoke = (key: string) =>
      tx.runRoot(scope, () =>
        receipts.execute(
          {
            tenantId: "tenant",
            namespace: "general",
            commandName: "grant",
            commandIdentity: "same",
            idempotencyKey: key,
            requestSchemaVersion: 1,
            payloadDigest: "a".repeat(64),
          },
          {
            schemaVersion: 1,
            encode: (value: { n: number }) => value,
            decode: (value: unknown) => value as { n: number },
          },
          async () => {
            effects += 1;
            await new Promise((resolve) => setTimeout(resolve, 30));
            return { n: effects };
          },
        ),
      );
    const results = await Promise.all([invoke("key-a"), invoke("key-b")]);
    expect(results.filter(({ replayed }) => !replayed)).toHaveLength(1);
    expect(effects).toBe(1);
    expect(
      await assertDefined(fixture).client.billing_command_key_binding.count(),
    ).toBe(2);
  });

  test("codec failure poisons the transaction even when business code catches it", async () => {
    const tx = new TransactionService(assertDefined(fixture).client);
    const receipts = new CommandReceiptRepository(tx);
    const scope = {
      tenantId: "tenant",
      actorId: "actor",
      operation: "codec",
      mode: "write" as const,
    };
    await tx.runRoot(scope, () =>
      receipts.execute(
        {
          tenantId: "tenant",
          namespace: "general",
          commandName: "c",
          commandIdentity: "i",
          idempotencyKey: "k",
          requestSchemaVersion: 1,
          payloadDigest: "a".repeat(64),
        },
        {
          schemaVersion: 1,
          encode: () => ({ ok: true }),
          decode: () => ({ ok: true }),
        },
        () => Promise.resolve({ ok: true }),
      ),
    );
    await expect(
      tx.runRoot(scope, async () => {
        try {
          await receipts.execute(
            {
              tenantId: "tenant",
              namespace: "general",
              commandName: "c",
              commandIdentity: "i",
              idempotencyKey: "k2",
              requestSchemaVersion: 1,
              payloadDigest: "a".repeat(64),
            },
            {
              schemaVersion: 1,
              encode: (v) => v,
              decode: () => {
                throw new Error("bad codec");
              },
            },
            () => Promise.resolve({ ok: false }),
          );
        } catch {
          /* deliberately swallowed */
        }
        await assertDefined(fixture).client.billing_command_receipt.count();
      }),
    ).rejects.toMatchObject({ code: "COMMAND_RECEIPT_CORRUPT" });
    expect(
      await assertDefined(fixture).client.billing_command_key_binding.count(),
    ).toBe(1);
  });

  test("rolls receipt, binding, audit, outbox, and effect back as one group", async () => {
    const tx = new TransactionService(assertDefined(fixture).client);
    const receipts = new CommandReceiptRepository(tx);
    const audit = new AuditAppender(tx);
    const outbox = new OutboxRepository(tx, audit);
    const scope = {
      tenantId: "tenant",
      actorId: "actor",
      operation: "group",
      mode: "write" as const,
    };
    await expect(
      tx.runRoot(scope, () =>
        receipts.execute<unknown>(
          {
            tenantId: "tenant",
            namespace: "payment",
            commandName: "refund",
            commandIdentity: "refund-1",
            idempotencyKey: "key",
            requestSchemaVersion: 1,
            payloadDigest: "a".repeat(64),
          },
          { schemaVersion: 1, encode: (v) => v, decode: (v) => v },
          async () => {
            await audit.append({
              tenantId: "tenant",
              action: "refund",
              resourceType: "refund",
              reason: "test",
              payload: {},
            });
            await outbox.enqueue({
              tenantId: "tenant",
              namespace: "payment",
              aggregateType: "refund",
              aggregateId: "00000000-0000-4000-8000-000000000001",
              eventType: "RefundCreditEffectRequested",
              eventIdentity: "refund-1",
              payloadSchemaVersion: 1,
              payloadDigest: "b".repeat(64),
              payload: {},
            });
            throw new Error("tail failure");
          },
        ),
      ),
    ).rejects.toThrow("tail failure");
    expect(
      await Promise.all([
        assertDefined(fixture).client.billing_command_receipt.count(),
        assertDefined(fixture).client.billing_command_key_binding.count(),
        assertDefined(fixture).client.billing_audit_event.count(),
        assertDefined(fixture).client.billing_outbox.count(),
      ]),
    ).toEqual([0, 0, 0, 0]);
  });

  test("classifies a cross-scope key target as corruption before a valid identity collision", async () => {
    const database = assertDefined(fixture).client;
    const foreignReceiptId = randomUUID();
    const localReceiptId = randomUUID();
    const base = {
      command_namespace: "general",
      api_surface: "internal",
      command_name: "grant",
      command_identity: "identity",
      request_schema_version: 1,
      payload_digest: "a".repeat(64),
      status: "succeeded",
      result_schema_version: 1,
      result_json: { ok: true },
    };
    await database.billing_command_receipt.createMany({
      data: [
        { ...base, id: foreignReceiptId, tenant_id: "foreign" },
        { ...base, id: localReceiptId, tenant_id: "tenant" },
      ],
    });
    await database.billing_command_key_binding.create({
      data: {
        id: randomUUID(),
        tenant_id: "tenant",
        command_namespace: "general",
        api_surface: "internal",
        command_name: "grant",
        idempotency_key: "corrupt-key",
        command_receipt_id: foreignReceiptId,
      },
    });
    const tx = new TransactionService(database);
    const receipts = new CommandReceiptRepository(tx);
    await expect(
      tx.runRoot(
        {
          tenantId: "tenant",
          actorId: "actor",
          operation: "corrupt-binding",
          mode: "write",
        },
        () =>
          receipts.execute(
            {
              tenantId: "tenant",
              namespace: "general",
              commandName: "grant",
              commandIdentity: "identity",
              idempotencyKey: "corrupt-key",
              requestSchemaVersion: 1,
              payloadDigest: "a".repeat(64),
            },
            {
              schemaVersion: 1,
              encode: (value: { ok: boolean }) => value,
              decode: (value: unknown) => value as { ok: boolean },
            },
            () => Promise.resolve({ ok: false }),
          ),
      ),
    ).rejects.toMatchObject({ code: "COMMAND_RECEIPT_CORRUPT" });
  });
});
