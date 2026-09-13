import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { PrismaClient } from "../generated/prisma/client.js";
import type {
  PrismaLifecycleGate,
  PrismaLifecycleState,
  PrismaServiceOptions,
} from "./prisma.types.js";

export class PrismaService implements PrismaLifecycleGate {
  readonly #pool: Pool;
  readonly #client: PrismaClient;
  #state: PrismaLifecycleState = "created";
  #init: Promise<void> | undefined;
  #close: Promise<void> | undefined;

  constructor(options: PrismaServiceOptions) {
    this.#pool = new Pool({
      connectionString: options.databaseUrl,
      max: options.pool?.max ?? 10,
      connectionTimeoutMillis: options.pool?.connectionTimeoutMillis ?? 2_000,
      options:
        "-c search_path=public,pg_catalog -c timezone=UTC -c statement_timeout=10000 -c lock_timeout=2000 -c idle_in_transaction_session_timeout=10000",
    });
    this.#client = new PrismaClient({ adapter: new PrismaPg(this.#pool) });
  }

  get state(): PrismaLifecycleState {
    return this.#state;
  }

  assertReady(): void {
    if (this.#state !== "ready") throw new Error("PRISMA_SERVICE_NOT_READY");
  }

  clientForDatabaseInfrastructure(): PrismaClient {
    if (this.#state === "closing" || this.#state === "closed")
      throw new Error("PRISMA_SERVICE_CLOSED");
    return this.#client;
  }

  onModuleInit(): Promise<void> {
    if (this.#state === "ready") return Promise.resolve();
    if (this.#state === "closing" || this.#state === "closed")
      return Promise.reject(new Error("PRISMA_SERVICE_CLOSED"));
    if (this.#init !== undefined) return this.#init;
    this.#state = "initializing";
    this.#init = this.#initialize();
    return this.#init;
  }

  async #initialize(): Promise<void> {
    try {
      await this.#client.$connect();
      await this.#client.$queryRaw`SELECT 1`;
      if (this.#state !== "initializing")
        throw new Error("PRISMA_SERVICE_CLOSED_DURING_INIT");
      this.#state = "ready";
    } catch (error) {
      if (this.#close === undefined) {
        this.#state = "closing";
        this.#close = this.#cleanup();
      }
      try {
        await this.#close;
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Prisma initialization and cleanup failed",
          // The initialization error is deliberately primary; cleanup is secondary.
          // eslint-disable-next-line preserve-caught-error
          { cause: error },
        );
      }
      throw error instanceof Error
        ? error
        : new Error("Prisma initialization failed", { cause: error });
    }
  }

  onModuleDestroy(): Promise<void> {
    if (this.#close !== undefined) return this.#close;
    this.#state = "closing";
    this.#close = this.#cleanup();
    return this.#close;
  }

  async #cleanup(): Promise<void> {
    const secondary: unknown[] = [];
    await this.#client
      .$disconnect()
      .catch((error: unknown) => secondary.push(error));
    await this.#pool.end().catch((error: unknown) => secondary.push(error));
    this.#state = "closed";
    if (secondary.length > 0)
      throw new AggregateError(secondary, "Prisma cleanup failed", {
        cause: secondary[0],
      });
  }
}
