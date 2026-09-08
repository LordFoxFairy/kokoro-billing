export class SchemaVerificationResourceError extends Error {
  public constructor(
    public readonly referenceName: string,
    public readonly stage: "creation-unconfirmed" | "cleanup-failed",
    options?: ErrorOptions,
  ) {
    super(
      stage === "creation-unconfirmed"
        ? `reference database creation is unconfirmed: ${referenceName}`
        : `reference database cleanup failed: ${referenceName}`,
      options,
    );
    this.name = "SchemaVerificationResourceError";
  }
}

export function findSchemaVerificationResourceError(
  error: unknown,
): SchemaVerificationResourceError | undefined {
  const pending: unknown[] = [error];
  const visited = new Set<object>();
  while (pending.length > 0) {
    const current = pending.shift();
    if (!(current instanceof Error) || visited.has(current)) continue;
    visited.add(current);
    if (
      current instanceof SchemaVerificationResourceError &&
      /^billing_reference_[0-9a-f]{32}$/u.test(current.referenceName)
    )
      return current;
    if (current instanceof AggregateError) pending.push(...current.errors);
    if (current.cause !== undefined) pending.push(current.cause);
  }
  return undefined;
}

export function safeSchemaVerificationErrorMessage(error: unknown): string {
  const resource = findSchemaVerificationResourceError(error);
  return resource
    ? `schema verification ${resource.stage}: ${resource.referenceName}; inspect only this named resource`
    : "schema verification failed; inspect configuration and database state";
}
