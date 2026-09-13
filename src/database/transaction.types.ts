import type { Prisma } from "../generated/prisma/client.js";
import type { PrismaClient } from "../generated/prisma/client.js";

export const transactionModes = ["write", "readOnlySnapshot"] as const;
export type TransactionMode = (typeof transactionModes)[number];

export type TransactionScope = Readonly<{
  tenantId: string;
  actorId: string;
  operation: string;
  mode: TransactionMode;
}>;

export type ActiveTransaction = Readonly<{
  scope: TransactionScope;
  client: TransactionClient;
}>;

export type TransactionOptions = Readonly<{
  maxWaitMs: number;
  timeoutMs: number;
  statementTimeoutMs: number;
  lockTimeoutMs: number;
  idleInTransactionTimeoutMs: number;
}>;

export const defaultTransactionOptions: TransactionOptions = Object.freeze({
  maxWaitMs: 1_000,
  timeoutMs: 10_000,
  statementTimeoutMs: 8_000,
  lockTimeoutMs: 1_000,
  idleInTransactionTimeoutMs: 10_000,
});

export const maximumTransactionTimeoutMs = 2_147_483_647;

export type TransactionClient = Prisma.TransactionClient;

type ReadMethod =
  | "findUnique"
  | "findUniqueOrThrow"
  | "findFirst"
  | "findFirstOrThrow"
  | "findMany"
  | "count"
  | "aggregate"
  | "groupBy";
type ReadDelegate<T> = Pick<T, Extract<keyof T, ReadMethod>>;
type PrismaModelKey = {
  [K in keyof PrismaClient]: K extends `$${string}`
    ? never
    : PrismaClient[K] extends object
      ? K
      : never;
}[keyof PrismaClient];

export type RootReadClient = {
  readonly [K in PrismaModelKey]: ReadDelegate<PrismaClient[K]>;
};
