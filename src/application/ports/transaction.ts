/** Application-owned transaction boundary implemented by persistence adapters. */
export interface TransactionPort {
  withTransaction<T>(work: () => Promise<T>): Promise<T>;
}
