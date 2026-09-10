import { assertDefined } from '../assert-defined.js';
import { describe, expect, it } from 'vitest';
import { RedisLease } from '../../src/infrastructure/redis/lease.js';

const url = process.env.REDIS_TEST_URL;
const integration = describe.skipIf(!url);

integration('billing Redis lease', () => {
  it('allows one leader and releases the lease after completion', async () => {
    const namespace = `test:lease:${Date.now()}`;
    const first = new RedisLease(assertDefined(url), namespace);
    const second = new RedisLease(assertDefined(url), namespace);
    await first.connect();
    await second.connect();
    try {
      const held = await first.runExclusive('sweep', 30, async () => {
        expect(await second.runExclusive('sweep', 30, async () => Promise.resolve('unexpected'))).toBeUndefined();
        return 'done';
      });
      expect(held).toBe('done');
      expect(await second.runExclusive('sweep', 30, async () => Promise.resolve('reacquired'))).toBe('reacquired');
    } finally {
      await first.close();
      await second.close();
    }
  });

  it('renews a long-running lease until the owner finishes', async () => {
    const namespace = `test:lease-renew:${Date.now()}`;
    const first = new RedisLease(assertDefined(url), namespace);
    const second = new RedisLease(assertDefined(url), namespace);
    await first.connect();
    await second.connect();
    try {
      const held = await first.runExclusive('worker', 1, async () => {
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        expect(await second.runExclusive('worker', 1, async () => Promise.resolve('unexpected'))).toBeUndefined();
        return 'done';
      });
      expect(held).toBe('done');
      expect(await second.runExclusive('worker', 1, async () => Promise.resolve('reacquired'))).toBe('reacquired');
    } finally {
      await first.close();
      await second.close();
    }
  });
});
