import type { FastifyAdapter } from "@nestjs/platform-fastify";
import type * as NestCore from "@nestjs/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
const flow = vi.hoisted(() => ({
  pending: false,
  adapter: undefined as FastifyAdapter | undefined,
  enter: undefined as (() => void) | undefined,
  release: undefined as (() => void) | undefined,
}));
const fake = vi.hoisted(() => ({
  init: vi.fn((): Promise<void> => Promise.resolve()),
  listen: vi.fn((): Promise<void> => Promise.resolve()),
  close: vi.fn((): Promise<void> => Promise.resolve()),
}));
vi.mock("@nestjs/core", async (original) => ({
  ...(await original<typeof NestCore>()),
  NestFactory: {
    create: vi.fn((_module: unknown, adapter: FastifyAdapter) => {
      flow.adapter = adapter;
      if (flow.pending)
        adapter.getInstance().get("/pending", async () => {
          flow.enter?.();
          await new Promise<void>((resolve) => {
            flow.release = resolve;
          });
          return { ok: true };
        });
      return Promise.resolve(fake);
    }),
  },
}));
import { createBillingRuntime } from "../../src/bootstrap/create-billing-runtime.js";
import { readBillingRuntimeConfig } from "../../src/config/runtime-config.js";
const config = () =>
  readBillingRuntimeConfig({
    DATABASE_URL: "postgresql://unused@localhost/unused?schema=kokoro_billing",
    BILLING_AUTH_MODE: "jwks",
    BILLING_AUTH_JWKS_URL: "https://iam.example.test/iam/jwks",
    BILLING_AUTH_JWT_ISSUER: "https://iam.example.test/iam",
    BILLING_AUTH_JWT_AUDIENCE: "https://kokoro.dev/resources/billing",
    INTERNAL_SERVICE_SECRET: "runtime-fixture-internal-secret-00001",
    BILLING_BFF_SERVICE_TOKEN: "runtime-fixture-bff-token-00000000001",
    BILLING_OPERATOR_PROXY_SECRET: "runtime-fixture-operator-secret-00001",
  });
beforeEach(() => {
  vi.clearAllMocks();
  flow.pending = false;
  flow.adapter = undefined;
  flow.enter = undefined;
  flow.release = undefined;
  fake.init.mockResolvedValue(undefined);
  fake.listen.mockResolvedValue(undefined);
  fake.close.mockResolvedValue(undefined);
});
describe("unique Billing runtime lifecycle", () => {
  it("retains init first cause and closes partially initialized Nest resources", async () => {
    const primary = new Error("private init failure");
    fake.init.mockRejectedValueOnce(primary);
    fake.close.mockRejectedValueOnce(new Error("cleanup failure"));
    await expect(createBillingRuntime(config())).rejects.toMatchObject({
      cause: primary,
      errors: [primary, expect.any(Error)],
    });
    expect(fake.close).toHaveBeenCalledTimes(1);
    expect(fake.listen).not.toHaveBeenCalled();
  });
  it("shares concurrent listen and close promises and rejects reopening", async () => {
    const runtime = await createBillingRuntime(config());
    const first = runtime.listen();
    expect(runtime.listen()).toBe(first);
    await first;
    const closing = runtime.close();
    expect(runtime.close()).toBe(closing);
    await closing;
    expect(fake.listen).toHaveBeenCalledTimes(1);
    expect(fake.close).toHaveBeenCalledTimes(1);
    await expect(runtime.listen()).rejects.toThrow("closing");
  });
  it("closes once after listen failure and preserves the bind error", async () => {
    const primary = new Error("bind failed");
    fake.listen.mockRejectedValueOnce(primary);
    const runtime = await createBillingRuntime(config());
    await expect(runtime.listen()).rejects.toBe(primary);
    await runtime.close();
    expect(fake.close).toHaveBeenCalledTimes(1);
  });
  it("drains a pending listen before destroying resources", async () => {
    let complete: (() => void) | undefined;
    fake.listen.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    const runtime = await createBillingRuntime(config());
    const listening = runtime.listen();
    const closing = runtime.close();
    await Promise.resolve();
    expect(fake.close).not.toHaveBeenCalled();
    complete?.();
    await listening;
    await closing;
    expect(fake.close).toHaveBeenCalledTimes(1);
  });
  it("keeps database providers alive while an actual request and adapter drain are pending", async () => {
    flow.pending = true;
    const entered = new Promise<void>((resolve) => {
      flow.enter = resolve;
    });
    const runtime = await createBillingRuntime(config());
    if (!flow.adapter) throw new Error("Missing actual Fastify adapter");
    const response = flow.adapter
      .getInstance()
      .inject({ method: "GET", url: "/pending" })
      .then((value) => value);
    await entered;
    // Inject has no listening TCP server; control the adapter drain completion
    // here. The source/dist integration test verifies native TCP + SIGTERM.
    const originalClose = flow.adapter.close.bind(flow.adapter);
    vi.spyOn(flow.adapter, "close").mockImplementationOnce(() =>
      response.then(() => originalClose()),
    );
    const closing = runtime.close();
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(fake.close).not.toHaveBeenCalled();
    } finally {
      flow.release?.();
    }
    const drainedResponse = await response;
    await closing;
    expect(drainedResponse.statusCode).toBe(200);
    expect(drainedResponse.headers.connection).toBe("close");
    expect(fake.close).toHaveBeenCalledTimes(1);
  });

  it("retains HTTP drain failure as primary while still attempting provider cleanup once", async () => {
    const runtime = await createBillingRuntime(config());
    if (!flow.adapter) throw new Error("Missing actual Fastify adapter");
    const primary = new Error("drain failed");
    const secondary = new Error("provider cleanup failed");
    vi.spyOn(flow.adapter, "close").mockRejectedValueOnce(primary);
    fake.close.mockRejectedValueOnce(secondary);
    const closing = runtime.close();
    expect(runtime.close()).toBe(closing);
    await expect(closing).rejects.toMatchObject({
      cause: primary,
      errors: [primary, secondary],
    });
    expect(fake.close).toHaveBeenCalledTimes(1);
  });
});
