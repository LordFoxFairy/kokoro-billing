import "reflect-metadata";
import { Test, type TestingModule } from "@nestjs/testing";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { DatabaseModule } from "../../src/database/database.module.js";
import { PrismaService } from "../../src/database/prisma.service.js";
import { TransactionContextError } from "../../src/database/transaction.error.js";
import { TransactionService } from "../../src/database/transaction.service.js";
import {
  createPrismaDatabaseFixture,
  type PrismaDatabaseFixture,
} from "./prisma-database.fixture.js";

const adminUrl = process.env.SCHEMA_ADMIN_URL;

describe.skipIf(adminUrl === undefined)("Prisma database lifecycle", () => {
  let fixture: PrismaDatabaseFixture | undefined;
  let context: TestingModule | undefined;

  beforeEach(async () => {
    if (adminUrl === undefined) throw new Error("SCHEMA_ADMIN_URL is required");
    fixture = await createPrismaDatabaseFixture(adminUrl);
  });

  afterEach(async () => {
    const errors: unknown[] = [];
    await context?.close().catch((error: unknown) => errors.push(error));
    await fixture?.close().catch((error: unknown) => errors.push(error));
    context = undefined;
    fixture = undefined;
    if (errors.length > 0)
      throw new AggregateError(errors, "fixture cleanup failed");
  });

  async function createContext(): Promise<TestingModule> {
    if (fixture === undefined) throw new Error("fixture is not initialized");
    const module = await Test.createTestingModule({
      imports: [
        DatabaseModule.register({
          databaseUrl: fixture.url,
          pool: { max: 2, connectionTimeoutMillis: 1_000 },
        }),
      ],
    }).compile();
    await module.init();
    context = module;
    return module;
  }

  test("initializes one Prisma owner and closes it idempotently", async () => {
    const module = await createContext();
    const prisma = module.get(PrismaService);
    expect(prisma.state).toBe("ready");
    expect(module.get(PrismaService)).toBe(prisma);

    await module.close();
    await module.close();
    context = undefined;
    expect(prisma.state).toBe("closed");
    expect(() => prisma.clientForDatabaseInfrastructure()).toThrow(
      "PRISMA_SERVICE_CLOSED",
    );
  });

  test("exposes bounded root reads and rejects mutations, raw SQL, and escaped clients", async () => {
    const module = await createContext();
    const transactions = module.get(TransactionService);
    expect(
      await transactions.readRoot(async (client) =>
        client.billing_credit_account.count(),
      ),
    ).toBe(0);

    await expect(
      transactions.readRoot(async (client) => {
        const unsafe = client as unknown as {
          billing_credit_account: { deleteMany(): Promise<unknown> };
        };
        return await unsafe.billing_credit_account.deleteMany();
      }),
    ).rejects.toMatchObject({ code: "ROOT_READ_ONLY" });
    await expect(
      transactions.readRoot(async (client) => {
        const unsafe = client as unknown as {
          $queryRaw(query: TemplateStringsArray): Promise<unknown>;
        };
        return await unsafe.$queryRaw`SELECT 1`;
      }),
    ).rejects.toMatchObject({ code: "ROOT_READ_ONLY" });

    let escaped:
      Parameters<Parameters<TransactionService["readRoot"]>[0]>[0] | undefined;
    await transactions.readRoot(async (client) => {
      escaped = client;
      return await client.billing_credit_account.count();
    });
    await expect(escaped?.billing_credit_account.count()).rejects.toMatchObject(
      {
        code: "TRANSACTION_CONTEXT_CLOSED",
      },
    );
  });

  test("runRoot and readRoot preserve the active transaction boundary", async () => {
    const module = await createContext();
    const transactions = module.get(TransactionService);
    const scope = {
      tenantId: "00000000-0000-4000-8000-000000000001",
      actorId: "actor",
      operation: "lifecycle-boundary",
      mode: "write" as const,
    };
    let rootReadCalls = 0;
    await transactions.runRoot(scope, async () => {
      await expect(
        transactions.readRoot(() => {
          rootReadCalls += 1;
          return Promise.resolve(0);
        }),
      ).rejects.toBeInstanceOf(TransactionContextError);
      await expect(
        transactions.runRoot(scope, () => Promise.resolve(1)),
      ).rejects.toMatchObject({ code: "TRANSACTION_ALREADY_ACTIVE" });
    });
    expect(rootReadCalls).toBe(0);
  });

  test("checks the transaction boundary again before every root read query", async () => {
    const module = await createContext();
    const transactions = module.get(TransactionService);
    const scope = {
      tenantId: "00000000-0000-4000-8000-000000000001",
      actorId: "actor",
      operation: "nested-root-read",
      mode: "write" as const,
    };
    await transactions.readRoot(async (rootClient) => {
      await transactions.runRoot(scope, async () => {
        await expect(
          rootClient.billing_credit_account.count(),
        ).rejects.toMatchObject({ code: "TRANSACTION_ALREADY_ACTIVE" });
      });
      return 0;
    });
  });

  test("an already injected transaction service rejects both roots after close", async () => {
    const module = await createContext();
    const transactions = module.get(TransactionService);
    await module.close();
    context = undefined;
    const scope = {
      tenantId: "00000000-0000-4000-8000-000000000001",
      actorId: "actor",
      operation: "closed-root",
      mode: "write" as const,
    };
    await expect(
      transactions.readRoot(() => Promise.resolve(0)),
    ).rejects.toMatchObject({ code: "DATABASE_NOT_READY" });
    await expect(
      transactions.runRoot(scope, () => Promise.resolve(0)),
    ).rejects.toMatchObject({ code: "DATABASE_NOT_READY" });
  });

  test("shares concurrent initialization and cleanup without reopening", async () => {
    if (fixture === undefined) throw new Error("fixture is not initialized");
    const prisma = new PrismaService({ databaseUrl: fixture.url });
    const first = prisma.onModuleInit();
    const second = prisma.onModuleInit();
    expect(second).toBe(first);
    const closing = prisma.onModuleDestroy();
    await Promise.allSettled([first, second, closing]);
    expect(prisma.state).toBe("closed");
    await expect(prisma.onModuleDestroy()).resolves.toBeUndefined();
  });

  test("shares cleanup after initialization failure", async () => {
    const prisma = new PrismaService({
      databaseUrl: "postgresql://127.0.0.1:1/unreachable",
      pool: { connectionTimeoutMillis: 50 },
    });
    const initialized = prisma.onModuleInit();
    await expect(initialized).rejects.toBeInstanceOf(Error);
    expect(prisma.state).toBe("closed");
    await expect(prisma.onModuleDestroy()).resolves.toBeUndefined();
    await expect(prisma.onModuleDestroy()).resolves.toBeUndefined();
  });

  test("rejects a root read client borrowed by another async context", async () => {
    const module = await createContext();
    const transactions = module.get(TransactionService);
    let borrowed:
      Parameters<Parameters<TransactionService["readRoot"]>[0]>[0] | undefined;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ready!: () => void;
    const captured = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const owner = transactions.readRoot(async (client) => {
      borrowed = client;
      ready();
      await gate;
      return await client.billing_credit_account.count();
    });
    try {
      await captured;
      await expect(
        borrowed?.billing_credit_account.count(),
      ).rejects.toMatchObject({ code: "TRANSACTION_CONTEXT_MISMATCH" });
    } finally {
      release();
      await owner;
    }
  });
});
