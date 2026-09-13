import type { PoolConfig } from "pg";

export type PrismaServiceOptions = Readonly<{
  databaseUrl: string;
  pool?: Readonly<Pick<PoolConfig, "max" | "connectionTimeoutMillis">>;
}>;

export type PrismaLifecycleState =
  "created" | "initializing" | "ready" | "closing" | "closed";

export type PrismaLifecycleGate = Readonly<{ assertReady(): void }>;
