import { NestFactory } from "@nestjs/core";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import type { FastifyInstance } from "fastify";
import { AppModule } from "../app.module.js";
import type { BillingRuntimeConfig } from "../config/runtime-config.js";

export type BillingRuntime = Readonly<{
  server: FastifyInstance;
  close: () => Promise<void>;
}>;

/** Builds the single normal Nest/Fastify Billing process. */
export async function createBillingRuntime(
  config: BillingRuntimeConfig,
): Promise<BillingRuntime> {
  const adapter = new FastifyAdapter();
  const app = await NestFactory.create(AppModule.register(config), adapter, {
    bufferLogs: true,
  });
  const server = adapter.getInstance();
  try {
    await app.init();
    await server.ready();
  } catch (error) {
    await app.close().catch(() => undefined);
    throw error;
  }
  let closing: Promise<void> | undefined;
  return {
    server: server as unknown as FastifyInstance,
    close: () => (closing ??= app.close()),
  };
}
