import { createClient, type RedisClientType } from 'redis';
import { z } from 'zod';
import {
  DEFAULT_REDIS_TIMEOUT_POLICY,
  closeRedisWithDeadline,
  connectRedisWithDeadline,
  runIdempotentRedisOperation,
  type RedisTimeoutPolicy,
} from './timeout-policy.js';

type ClaimRecord = { readonly fingerprint: string; readonly response?: unknown };
const claimRecordSchema = z.object({ fingerprint: z.string().min(1), response: z.unknown().optional() }).strict();
export type IdempotencyClaim = 'claimed' | 'replay' | 'conflict';

/**
 * Redis is only a fast-path hint. The PostgreSQL command receipt remains the final
 * idempotency authority and must be checked by every mutating use case.
 */
export class RedisIdempotencyHint {
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

  public async claim(key: string, fingerprint: string, ttlSeconds: number): Promise<IdempotencyClaim> {
    const redisKey = this.key(key);
    const value = JSON.stringify({ fingerprint });
    const claimed = await runIdempotentRedisOperation('claim', this.timeouts, () => this.client.set(redisKey, value, { NX: true, EX: ttlSeconds }));
    if (claimed === 'OK') return 'claimed';

    const current = await this.readRecord(redisKey);
    return current?.fingerprint === fingerprint ? 'replay' : 'conflict';
  }

  public async remember(key: string, response: unknown, ttlSeconds: number): Promise<void> {
    const redisKey = this.key(key);
    const current = await this.readRecord(redisKey);
    if (!current) return;
    const value = JSON.stringify({ fingerprint: current.fingerprint, response });
    await runIdempotentRedisOperation('remember', this.timeouts, () => this.client.set(redisKey, value, { EX: ttlSeconds }));
  }

  public async read(key: string): Promise<ClaimRecord | null> {
    return this.readRecord(this.key(key));
  }

  private key(key: string): string {
    return `${this.namespace}:${key}`;
  }

  private async readRecord(redisKey: string): Promise<ClaimRecord | null> {
    const value = await runIdempotentRedisOperation('read', this.timeouts, () => this.client.get(redisKey));
    if (value === null) return null;
    try {
      const parsed: unknown = JSON.parse(value);
      const record = claimRecordSchema.safeParse(parsed);
      return record.success ? record.data : null;
    } catch {
      return null;
    }
  }
}
