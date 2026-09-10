import { assertDefined } from "../assert-defined.js";
import { describe, expect, it } from "vitest";
import { RedisIdempotencyHint } from "../../src/infrastructure/redis/idempotency-hint.js";
import { createClient } from "redis";

const url = process.env.REDIS_TEST_URL;
const integration = describe.skipIf(!url);

integration("billing Redis idempotency hint", () => {
  it("stores only a short-lived key-presence marker", async () => {
    const redis = new RedisIdempotencyHint(assertDefined(url));
    const raw = createClient({ url: assertDefined(url) });
    await Promise.all([redis.connect(), raw.connect()]);
    const key = `test:${Date.now()}`;
    const redisKey = `billing:idempotency:${key}`;
    try {
      await redis.markSeen(key, 30);
      await redis.markSeen(key, 30);
      expect(await raw.get(redisKey)).toBe("seen");
    } finally {
      await raw.del(redisKey);
      await Promise.all([redis.close(), raw.quit()]);
    }
  });

  it("does not interpret a malformed legacy value as replay or conflict", async () => {
    const redis = new RedisIdempotencyHint(assertDefined(url));
    const raw = createClient({ url: assertDefined(url) });
    await Promise.all([redis.connect(), raw.connect()]);
    const key = `invalid:${Date.now()}`;
    const redisKey = `billing:idempotency:${key}`;
    try {
      await raw.set(redisKey, JSON.stringify({ fingerprint: 42 }), { EX: 30 });
      await expect(redis.markSeen(key, 30)).resolves.toBeUndefined();
    } finally {
      await raw.del(redisKey);
      await Promise.all([redis.close(), raw.quit()]);
    }
  });
});
