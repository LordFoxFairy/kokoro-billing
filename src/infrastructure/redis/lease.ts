import { randomUUID } from 'node:crypto';
import { createClient, type RedisClientType } from 'redis';

const RELEASE_IF_OWNER = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
`;
const RENEW_IF_OWNER = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('expire', KEYS[1], ARGV[2])
end
return 0
`;

/**
 * Best-effort process coordination. It prevents duplicate sweep leaders, but
 * correctness must still come from PostgreSQL row locks and idempotent facts.
 */
export class RedisLease {
  private readonly client: RedisClientType;
  private connected = false;

  public constructor(url: string, private readonly namespace = 'billing:lease') {
    this.client = createClient({ url });
    this.client.on('error', (error) => process.stderr.write(`kokoro-billing redis error: ${String(error)}\n`));
  }

  public async connect(): Promise<void> {
    if (!this.connected) {
      await this.client.connect();
      this.connected = true;
    }
  }

  public async close(): Promise<void> {
    if (this.connected) {
      try { await this.client.quit(); } catch (error) {
        process.stderr.write(`kokoro-billing redis close failed error=${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
    this.connected = false;
  }

  public async runExclusive<T>(name: string, ttlSeconds: number, task: () => Promise<T>): Promise<T | undefined> {
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) throw new RangeError('lease ttl must be a positive safe integer');
    const token = randomUUID();
    const key = `${this.namespace}:${name}`;
    let acquired: string | null;
    try {
      acquired = await this.client.set(key, token, { NX: true, EX: ttlSeconds });
    } catch (error) {
      // Redis is coordination only. PostgreSQL row locks/idempotent facts remain the
      // correctness boundary, so a Redis outage degrades to concurrent workers
      // instead of taking the billing mutation path offline.
      process.stderr.write(`kokoro-billing redis lease unavailable name=${name} error=${error instanceof Error ? error.message : String(error)}\n`);
      return task();
    }
    if (acquired !== 'OK') return undefined;
    let renewing = false;
    const renewal = setInterval(() => {
      if (renewing) return;
      renewing = true;
      void this.client.eval(RENEW_IF_OWNER, { keys: [key], arguments: [token, String(ttlSeconds)] }).catch(() => undefined).finally(() => { renewing = false; });
    }, Math.max(250, Math.floor(ttlSeconds * 1000 / 3)));
    try {
      return await task();
    } finally {
      clearInterval(renewal);
      try {
        await this.client.eval(RELEASE_IF_OWNER, { keys: [key], arguments: [token] });
      } catch (error) {
        process.stderr.write(`kokoro-billing redis lease release failed name=${name} error=${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
  }
}
