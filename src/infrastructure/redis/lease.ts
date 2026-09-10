import { randomUUID } from "node:crypto";
import { createClient, type RedisClientType } from "redis";
import {
  DEFAULT_REDIS_TIMEOUT_POLICY,
  closeRedisWithDeadline,
  connectRedisWithDeadline,
  runIdempotentRedisOperation,
  type RedisTimeoutPolicy,
} from "./timeout-policy.js";

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

  public constructor(
    url: string,
    private readonly namespace = "billing:lease",
    private readonly timeouts: RedisTimeoutPolicy = DEFAULT_REDIS_TIMEOUT_POLICY,
  ) {
    this.client = createClient({
      url,
      socket: {
        connectTimeout: timeouts.connectTimeoutMs,
        reconnectStrategy: false,
      },
    });
    this.client.on("error", (error) =>
      process.stderr.write(`kokoro-billing redis error: ${String(error)}\n`),
    );
  }

  public async connect(): Promise<void> {
    if (!this.connected) {
      try {
        await connectRedisWithDeadline(this.client.connect(), this.timeouts);
        this.connected = true;
      } catch (error) {
        if (this.client.isOpen) this.client.destroy();
        throw error;
      }
    }
  }

  public async close(): Promise<void> {
    if (this.connected) {
      try {
        await closeRedisWithDeadline(this.client.quit(), this.timeouts);
      } catch (error) {
        process.stderr.write(
          `kokoro-billing redis close failed error=${error instanceof Error ? error.message : String(error)}\n`,
        );
        this.client.destroy();
      }
    }
    this.connected = false;
  }

  public async runExclusive<T>(
    name: string,
    ttlSeconds: number,
    task: () => Promise<T>,
  ): Promise<T | undefined> {
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0)
      throw new RangeError("lease ttl must be a positive safe integer");
    if (!this.connected) return task();
    const token = randomUUID();
    const key = `${this.namespace}:${name}`;
    let acquired: string | null;
    try {
      acquired = await runIdempotentRedisOperation(
        "lease-acquire",
        this.timeouts,
        () => this.client.set(key, token, { NX: true, EX: ttlSeconds }),
      );
    } catch (error) {
      // Redis is coordination only. PostgreSQL row locks/idempotent facts remain the
      // correctness boundary, so a Redis outage degrades to concurrent workers
      // instead of taking the billing mutation path offline.
      this.connected = false;
      if (this.client.isOpen) this.client.destroy();
      process.stderr.write(
        `kokoro-billing redis lease unavailable name=${name} error=${error instanceof Error ? error.message : String(error)}\n`,
      );
      return task();
    }
    if (acquired !== "OK") {
      let currentOwner: string | null;
      try {
        currentOwner = await runIdempotentRedisOperation(
          "lease-read-owner",
          this.timeouts,
          () => this.client.get(key),
        );
      } catch (error) {
        this.connected = false;
        if (this.client.isOpen) this.client.destroy();
        process.stderr.write(
          `kokoro-billing redis lease owner unavailable name=${name} error=${error instanceof Error ? error.message : String(error)}\n`,
        );
        return task();
      }
      if (currentOwner !== token) return undefined;
    }
    let renewing = false;
    const renewal = setInterval(
      () => {
        if (renewing) return;
        renewing = true;
        void runIdempotentRedisOperation("lease-renew", this.timeouts, () =>
          this.client.eval(RENEW_IF_OWNER, {
            keys: [key],
            arguments: [token, String(ttlSeconds)],
          }),
        )
          .catch(() => undefined)
          .finally(() => {
            renewing = false;
          });
      },
      Math.max(250, Math.floor((ttlSeconds * 1000) / 3)),
    );
    try {
      return await task();
    } finally {
      clearInterval(renewal);
      try {
        await runIdempotentRedisOperation("lease-release", this.timeouts, () =>
          this.client.eval(RELEASE_IF_OWNER, {
            keys: [key],
            arguments: [token],
          }),
        );
      } catch (error) {
        process.stderr.write(
          `kokoro-billing redis lease release failed name=${name} error=${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    }
  }
}
