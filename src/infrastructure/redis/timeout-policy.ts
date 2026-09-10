export type RedisTimeoutPolicy = Readonly<{
  connectTimeoutMs: number;
  readTimeoutMs: number;
  overallTimeoutMs: number;
}>;

export const DEFAULT_REDIS_TIMEOUT_POLICY: RedisTimeoutPolicy = {
  connectTimeoutMs: 2_000,
  readTimeoutMs: 1_000,
  overallTimeoutMs: 3_000,
};

export class RedisOperationTimeoutError extends Error {
  public override readonly name = "RedisOperationTimeoutError";

  public constructor(operation: string, timeoutMs: number) {
    super(`redis ${operation} exceeded ${timeoutMs}ms`);
  }
}

const withTimeout = async <T>(
  operation: Promise<T>,
  timeoutMs: number,
  name: string,
): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new RedisOperationTimeoutError(name, timeoutMs)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const redisErrorCode = (error: unknown): string | undefined => {
  if (error === null || typeof error !== "object" || !("code" in error))
    return undefined;
  return typeof error.code === "string" ? error.code : undefined;
};

const isRetryableRedisError = (error: unknown): boolean => {
  if (error instanceof RedisOperationTimeoutError) return true;
  if (
    error instanceof Error &&
    [
      "ConnectionTimeoutError",
      "SocketClosedUnexpectedlyError",
      "TimeoutError",
    ].includes(error.name)
  )
    return true;
  const code = redisErrorCode(error);
  return (
    code !== undefined &&
    [
      "ECONNRESET",
      "ECONNREFUSED",
      "EPIPE",
      "ETIMEDOUT",
      "ENETUNREACH",
      "EHOSTUNREACH",
    ].includes(code)
  );
};

/** The caller must only use this for operations that are safe to repeat verbatim. */
export const runIdempotentRedisOperation = async <T>(
  name: string,
  policy: RedisTimeoutPolicy,
  operation: () => Promise<T>,
): Promise<T> => {
  const deadline = Date.now() + policy.overallTimeoutMs;
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0)
      throw new RedisOperationTimeoutError(name, policy.overallTimeoutMs);
    try {
      return await withTimeout(
        operation(),
        Math.min(policy.readTimeoutMs, remainingMs),
        name,
      );
    } catch (error) {
      lastError = error;
      if (attempt > 0 || !isRetryableRedisError(error)) throw error;
    }
  }
  throw lastError;
};

export const connectRedisWithDeadline = async (
  operation: Promise<unknown>,
  policy: RedisTimeoutPolicy,
): Promise<void> => {
  await withTimeout(
    operation,
    Math.min(policy.connectTimeoutMs, policy.overallTimeoutMs),
    "connect",
  );
};

export const closeRedisWithDeadline = async (
  operation: Promise<unknown>,
  policy: RedisTimeoutPolicy,
): Promise<void> => {
  await withTimeout(operation, policy.overallTimeoutMs, "close");
};
