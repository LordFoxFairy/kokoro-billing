import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  queryError: undefined as Error | undefined,
  connect: vi.fn(),
  query: vi.fn(),
  release: vi.fn(),
  end: vi.fn(() => Promise.resolve()),
}));

vi.mock("pg", () => ({
  Pool: class {
    connect() {
      state.connect();
      return Promise.resolve({
        query: (
          config: { text: string; query_timeout: number },
          callback: (error: Error | null) => void,
        ) => {
          state.query(config);
          callback(state.queryError ?? null);
        },
        release: state.release,
      });
    }
    end = state.end;
  },
}));
vi.mock("@prisma/adapter-pg", () => ({ PrismaPg: class {} }));
vi.mock("../../src/generated/prisma/client.js", () => ({
  PrismaClient: class {
    $connect() {
      return Promise.resolve();
    }
    $queryRaw() {
      return Promise.resolve([1]);
    }
    $disconnect() {
      return Promise.resolve();
    }
  },
}));

import { PrismaService } from "../../src/database/prisma.service.js";

beforeEach(() => {
  vi.clearAllMocks();
  state.queryError = undefined;
});

describe("Prisma readiness ping", () => {
  const create = async () => {
    const service = new PrismaService({
      databaseUrl:
        "postgresql://billing@localhost/billing?schema=kokoro_billing",
    });
    await service.onModuleInit();
    return service;
  };

  it("uses an exclusive client with a client-side deadline and releases it", async () => {
    const service = await create();
    await expect(service.pingForReadiness()).resolves.toBeUndefined();
    expect(state.query).toHaveBeenCalledWith({
      text: "SELECT 1",
      query_timeout: 1_000,
    });
    expect(state.release).toHaveBeenCalledWith(false);
  });

  it("destroys a timed-out client before a later readiness retry", async () => {
    const service = await create();
    state.queryError = new Error("query read timeout");
    await expect(service.pingForReadiness()).rejects.toThrow(
      "query read timeout",
    );
    expect(state.release).toHaveBeenLastCalledWith(true);

    state.queryError = undefined;
    await expect(service.pingForReadiness()).resolves.toBeUndefined();
    expect(state.connect).toHaveBeenCalledTimes(2);
    expect(state.release).toHaveBeenLastCalledWith(false);
  });
});
