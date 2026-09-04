import { createClient, type RedisClientType } from 'redis';
import type { IdempotencyHint } from '../../application/ports/idempotency-hint.js';
import {
  DEFAULT_REDIS_TIMEOUT_POLICY,
  closeRedisWithDeadline,
  connectRedisWithDeadline,
  runIdempotentRedisOperation,
  type RedisTimeoutPolicy,
} from './timeout-policy.js';

/**
 * Redis stores only a lossy key-presence marker. PostgreSQL command receipts and
 * owner facts remain the only replay and conflict authority.
 */
export class RedisIdempotencyHint implements IdempotencyHint {
  private readonly client: RedisClientType;
  private connected = false;

  public constructor(
    url: string,
    private readonly namespace = 'billing:idempotency',
    private readonly timeouts: RedisTimeoutPolicy = DEFAULT_REDIS_TIMEOUT_POLICY,
  ) {
    this.client = createClient({ url, socket: { connectTimeout: timeouts.connectTimeoutMs, reconnectStrategy: false } });
    this.client.on('error', (error) => process.stderr.write(`kokoro-billing redis error: ${String(error)}\n`));
  }

  public async connect(): Promise<void> {
    if (!this.connected) {
      await connectRedisWithDeadline(this.client.connect(), this.timeouts);
      this.connected = true;
    }
  }

  public async close(): Promise<void> {
    if (this.connected) {
      try { await closeRedisWithDeadline(this.client.quit(), this.timeouts); } catch (error) {
        process.stderr.write(`kokoro-billing redis close failed error=${error instanceof Error ? error.message : String(error)}\n`);
        this.client.destroy();
      }
    }
    this.connected = false;
  }

  public async ping(): Promise<void> {
    await runIdempotentRedisOperation('ping', this.timeouts, () => this.client.ping());
  }

  public async markSeen(key: string, ttlSeconds: number): Promise<void> {
    await runIdempotentRedisOperation('mark-seen', this.timeouts, () => this.client.set(this.key(key), 'seen', { NX: true, EX: ttlSeconds }));
  }

  private key(key: string): string {
    return `${this.namespace}:${key}`;
  }
}
