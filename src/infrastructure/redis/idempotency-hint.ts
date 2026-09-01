import { createClient, type RedisClientType } from 'redis';

type ClaimRecord = { readonly fingerprint: string; readonly response?: unknown };
export type IdempotencyClaim = 'claimed' | 'replay' | 'conflict';

/**
 * Redis is only a fast-path hint. The PostgreSQL command receipt remains the final
 * idempotency authority and must be checked by every mutating use case.
 */
export class RedisIdempotencyHint {
  private readonly client: RedisClientType;
  private connected = false;

  public constructor(url: string, private readonly namespace = 'billing:idempotency') {
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

  public async ping(): Promise<void> {
    await this.client.ping();
  }

  public async claim(key: string, fingerprint: string, ttlSeconds: number): Promise<IdempotencyClaim> {
    const redisKey = this.key(key);
    const claimed = await this.client.set(redisKey, JSON.stringify({ fingerprint }), { NX: true, EX: ttlSeconds });
    if (claimed === 'OK') return 'claimed';

    const current = await this.readRecord(redisKey);
    return current?.fingerprint === fingerprint ? 'replay' : 'conflict';
  }

  public async remember(key: string, response: unknown, ttlSeconds: number): Promise<void> {
    const redisKey = this.key(key);
    const current = await this.readRecord(redisKey);
    if (!current) return;
    await this.client.set(redisKey, JSON.stringify({ fingerprint: current.fingerprint, response }), { EX: ttlSeconds });
  }

  public async read(key: string): Promise<ClaimRecord | null> {
    return this.readRecord(this.key(key));
  }

  private key(key: string): string {
    return `${this.namespace}:${key}`;
  }

  private async readRecord(redisKey: string): Promise<ClaimRecord | null> {
    const value = await this.client.get(redisKey);
    if (value === null) return null;
    try {
      return JSON.parse(value) as ClaimRecord;
    } catch {
      return null;
    }
  }
}
