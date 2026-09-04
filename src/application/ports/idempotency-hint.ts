/**
 * Best-effort observation of an idempotency key. Implementations may drop the
 * observation; command replay and conflict decisions belong to durable storage.
 */
export interface IdempotencyHint {
  markSeen(key: string, ttlSeconds: number): Promise<void>;
}
