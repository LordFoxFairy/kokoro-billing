import { AsyncLocalStorage } from "node:async_hooks";
import type { PrismaClient } from "../generated/prisma/client.js";
import {
  preserveTransactionFailure,
  TransactionContextError,
} from "./transaction.error.js";
import {
  defaultTransactionOptions,
  type TransactionClient,
  type TransactionMode,
  type TransactionOptions,
  type TransactionScope,
  maximumTransactionTimeoutMs,
} from "./transaction.types.js";

type TransactionState = {
  readonly scope: TransactionScope;
  readonly client: TransactionClient;
  active: boolean;
  hasRollbackCause: boolean;
  firstRollbackCause: unknown;
};

function extendPrisma(
  client: PrismaClient,
  beforeQuery: () => void,
  onError: (error: unknown) => void,
) {
  return client.$extends({
    query: {
      $allOperations: async ({ args, query }) => {
        beforeQuery();
        try {
          // Prisma's extension hook erases the operation-specific result type here.
          // eslint-disable-next-line @typescript-eslint/no-unsafe-return
          return await query(args);
        } catch (error) {
          onError(error);
          throw error;
        }
      },
    },
  });
}

export class TransactionService {
  readonly #storage = new AsyncLocalStorage<TransactionState>();
  readonly #client: PrismaClient;
  readonly #options: TransactionOptions;

  constructor(client: PrismaClient, options: Partial<TransactionOptions> = {}) {
    this.#options = Object.freeze({ ...defaultTransactionOptions, ...options });
    this.#validateOptions();
    this.#client = client;
  }

  async run<T>(
    scope: TransactionScope,
    callback: () => Promise<T>,
  ): Promise<T> {
    const current = this.#storage.getStore();
    if (current !== undefined) return this.#runNested(current, scope, callback);

    const rootScope = Object.freeze({ ...scope });
    let rootState: TransactionState | undefined;
    const guardedClient = extendPrisma(
      this.#client,
      () => this.#assertOwnedQueryAllowed(rootState),
      (error) => this.#markRollbackOnly(error),
    );
    try {
      return await guardedClient.$transaction(
        async (client) => {
          const state: TransactionState = {
            scope: rootScope,
            client: client as TransactionClient,
            active: true,
            hasRollbackCause: false,
            firstRollbackCause: undefined,
          };
          rootState = state;
          return this.#storage.run(state, async () => {
            const closeAtDeadline = setTimeout(() => {
              state.active = false;
            }, this.#options.timeoutMs);
            try {
              await this.#configure(
                client as TransactionClient,
                rootScope.mode,
              );
              const result = await callback();
              if (state.hasRollbackCause) throw state.firstRollbackCause;
              return result;
            } catch (error) {
              this.#markRollbackOnly(error);
              throw state.firstRollbackCause;
            } finally {
              clearTimeout(closeAtDeadline);
              state.active = false;
            }
          });
        },
        {
          maxWait: this.#options.maxWaitMs,
          timeout: this.#options.timeoutMs,
          isolationLevel:
            scope.mode === "readOnlySnapshot"
              ? "RepeatableRead"
              : "ReadCommitted",
        },
      );
    } catch (error) {
      if (
        rootState?.hasRollbackCause === true &&
        !Object.is(error, rootState.firstRollbackCause)
      )
        throw preserveTransactionFailure(rootState.firstRollbackCause, error);
      throw error;
    } finally {
      if (rootState !== undefined) rootState.active = false;
    }
  }

  requireActiveTransaction(
    expectedTenantId: string,
    expectedMode: TransactionMode,
  ): TransactionClient {
    const state = this.#storage.getStore();
    if (state === undefined)
      throw new TransactionContextError(
        "TRANSACTION_REQUIRED",
        "An active transaction is required",
      );
    if (!state.active)
      throw new TransactionContextError(
        "TRANSACTION_CONTEXT_CLOSED",
        "The transaction context is closed",
      );
    if (state.hasRollbackCause) throw state.firstRollbackCause;
    if (state.scope.tenantId !== expectedTenantId) {
      const error = new TransactionContextError(
        "TRANSACTION_CONTEXT_MISMATCH",
        "Transaction tenant does not match",
      );
      this.#markRollbackOnly(error);
      throw error;
    }
    if (state.scope.mode !== expectedMode) {
      const error = new TransactionContextError(
        "TRANSACTION_MODE_MISMATCH",
        "Transaction mode does not match",
      );
      this.#markRollbackOnly(error);
      throw error;
    }
    return state.client;
  }

  assertNoActiveTransaction(): void {
    const state = this.#storage.getStore();
    if (state === undefined) return;
    throw new TransactionContextError(
      state.active
        ? "TRANSACTION_ALREADY_ACTIVE"
        : "TRANSACTION_CONTEXT_CLOSED",
      state.active
        ? "A root operation cannot run inside a transaction"
        : "The inherited transaction context is closed",
    );
  }

  async #runNested<T>(
    state: TransactionState,
    scope: TransactionScope,
    callback: () => Promise<T>,
  ): Promise<T> {
    if (!state.active)
      throw new TransactionContextError(
        "TRANSACTION_CONTEXT_CLOSED",
        "The inherited transaction context is closed",
      );
    if (state.hasRollbackCause) throw state.firstRollbackCause;
    if (
      scope.tenantId !== state.scope.tenantId ||
      scope.actorId !== state.scope.actorId
    ) {
      const error = new TransactionContextError(
        "TRANSACTION_CONTEXT_MISMATCH",
        "Nested transaction identity does not match its root",
      );
      this.#markRollbackOnly(error);
      throw error;
    }
    if (scope.mode !== state.scope.mode) {
      const error = new TransactionContextError(
        "TRANSACTION_MODE_MISMATCH",
        "Nested transaction mode does not match its root",
      );
      this.#markRollbackOnly(error);
      throw error;
    }
    try {
      return await callback();
    } catch (error) {
      this.#markRollbackOnly(error);
      throw error;
    }
  }

  async #configure(client: TransactionClient, mode: TransactionMode) {
    if (mode === "readOnlySnapshot")
      await client.$executeRaw`SET TRANSACTION READ ONLY`;
    await client.$queryRaw`SELECT set_config('statement_timeout', ${`${this.#options.statementTimeoutMs}ms`}, true), set_config('lock_timeout', ${`${this.#options.lockTimeoutMs}ms`}, true), set_config('idle_in_transaction_session_timeout', ${`${this.#options.idleInTransactionTimeoutMs}ms`}, true), set_config('TimeZone', 'UTC', true), set_config('search_path', 'public, pg_catalog', true)`;
  }

  #markRollbackOnly(error: unknown): void {
    const state = this.#storage.getStore();
    if (state === undefined || state.hasRollbackCause) return;
    state.hasRollbackCause = true;
    state.firstRollbackCause = error;
  }

  #assertOwnedQueryAllowed(owner: TransactionState | undefined): void {
    const state = this.#storage.getStore();
    if (owner === undefined || state !== owner) {
      const error = new TransactionContextError(
        "TRANSACTION_CONTEXT_MISMATCH",
        "The transaction client belongs to another context",
      );
      this.#markRollbackOnly(error);
      throw error;
    }
    if (!state.active)
      throw new TransactionContextError(
        "TRANSACTION_CONTEXT_CLOSED",
        "The transaction context is closed",
      );
    if (state.hasRollbackCause) throw state.firstRollbackCause;
  }

  #validateOptions(): void {
    for (const [name, value] of Object.entries(this.#options)) {
      if (
        !Number.isSafeInteger(value) ||
        value <= 0 ||
        value > maximumTransactionTimeoutMs
      )
        throw new RangeError(
          `${name} must be an integer between 1 and ${maximumTransactionTimeoutMs}`,
        );
    }
    if (this.#options.statementTimeoutMs >= this.#options.timeoutMs)
      throw new RangeError("statementTimeoutMs must be less than timeoutMs");
    if (this.#options.lockTimeoutMs >= this.#options.statementTimeoutMs)
      throw new RangeError(
        "lockTimeoutMs must be less than statementTimeoutMs",
      );
    if (this.#options.idleInTransactionTimeoutMs < this.#options.timeoutMs)
      throw new RangeError(
        "idleInTransactionTimeoutMs must be at least timeoutMs",
      );
  }
}
