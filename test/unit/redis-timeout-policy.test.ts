import { describe, expect, it } from 'vitest';
import { runIdempotentRedisOperation } from '../../src/infrastructure/redis/timeout-policy.js';

const policy = { connectTimeoutMs: 50, readTimeoutMs: 50, overallTimeoutMs: 200 };

describe('Redis timeout and retry policy', () => {
  it('retries one retryable failure for an explicitly idempotent operation', async () => {
    let attempts = 0;
    const result = await runIdempotentRedisOperation('read', policy, async () => {
      attempts += 1;
      if (attempts === 1) {
        const error = new Error('timed out');
        Object.defineProperty(error, 'code', { value: 'ETIMEDOUT' });
        return Promise.reject(error);
      }
      return Promise.resolve('ok');
    });
    expect(result).toBe('ok');
    expect(attempts).toBe(2);
  });

  it('does not retry a non-retryable failure', async () => {
    let attempts = 0;
    await expect(runIdempotentRedisOperation('read', policy, async () => {
      attempts += 1;
      return Promise.reject(new Error('invalid command'));
    })).rejects.toThrow('invalid command');
    expect(attempts).toBe(1);
  });
});
