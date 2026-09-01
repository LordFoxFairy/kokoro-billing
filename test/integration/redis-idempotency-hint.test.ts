import { describe, expect, it } from 'vitest';
import { RedisIdempotencyHint } from '../../src/infrastructure/redis/idempotency-hint.js';

const url = process.env.REDIS_TEST_URL;
const integration = describe.skipIf(!url);

integration('billing Redis idempotency hint', () => {
  it('claims once and stores a short-lived response hint', async () => {
    const redis = new RedisIdempotencyHint(url!);
    await redis.connect();
    const key = `test:${Date.now()}`;
    try {
      expect(await redis.claim(key, 'hash-a', 30)).toBe('claimed');
      expect(await redis.claim(key, 'hash-a', 30)).toBe('replay');
      expect(await redis.claim(key, 'hash-b', 30)).toBe('conflict');
      await redis.remember(key, { status: 'succeeded' }, 30);
      expect(await redis.read(key)).toEqual({ fingerprint: 'hash-a', response: { status: 'succeeded' } });
    } finally {
      await redis.close();
    }
  });
});
