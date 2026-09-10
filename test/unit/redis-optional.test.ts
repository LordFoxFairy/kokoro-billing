import { describe, expect, it } from "vitest";
import { RedisIdempotencyHint } from "../../src/infrastructure/redis/idempotency-hint.js";
import { RedisLease } from "../../src/infrastructure/redis/lease.js";

describe("optional Redis coordination", () => {
  it("drops an idempotency observation when no Redis connection exists", async () => {
    const hint = new RedisIdempotencyHint("redis://127.0.0.1:1");
    await expect(
      hint.markSeen("tenant:operation:key", 30),
    ).resolves.toBeUndefined();
    await hint.close();
  });

  it("runs the PostgreSQL-protected task after the Redis lease connection fails", async () => {
    const lease = new RedisLease("redis://127.0.0.1:1", "test:unavailable", {
      connectTimeoutMs: 50,
      readTimeoutMs: 50,
      overallTimeoutMs: 50,
    });
    await expect(lease.connect()).rejects.toBeInstanceOf(Error);
    await expect(
      lease.runExclusive("expiry", 30, async () =>
        Promise.resolve("completed"),
      ),
    ).resolves.toBe("completed");
    await lease.close();
  });
});
