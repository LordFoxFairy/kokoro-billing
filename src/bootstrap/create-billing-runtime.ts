import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { LogController } from "fastify";
import { AppModule } from "../app.module.js";
import type { BillingRuntimeConfig } from "../config/runtime-config.js";

export type BillingRuntime = Readonly<{
  listen: () => Promise<void>;
  close: () => Promise<void>;
}>;

/** The unique source/dist composition root: canonical owner graph only. */
export async function createBillingRuntime(
  config: BillingRuntimeConfig,
): Promise<BillingRuntime> {
  const adapter = new FastifyAdapter({
    bodyLimit: 32_768,
    logger: {
      level:
        process.env.NODE_ENV === "test"
          ? "silent"
          : (process.env.LOG_LEVEL ?? "info"),
      redact: {
        censor: "[REDACTED]",
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          'req.headers["x-kokoro-internal-secret"]',
          'req.headers["x-kokoro-subject"]',
          'req.headers["x-kokoro-tenant-id"]',
        ],
      },
    },
    logController: new LogController({
      disableRequestLogging: true,
      requestIdLogLabel: "request_id",
    }),
    forceCloseConnections: "idle",
  });
  let draining = false;
  // Fastify marks only requests entering after close as Connection: close.
  // Requests already in handlers must also retire their keep-alive socket once
  // their response completes, without interrupting the response or DB access.
  adapter.getInstance().addHook("onSend", async (request, reply, payload) => {
    if (draining && request.raw.httpVersionMajor !== 2)
      reply.header("connection", "close");
    return payload;
  });
  let app: NestFastifyApplication | undefined;
  const destroy = async (): Promise<void> => {
    draining = true;
    let httpFailed = false;
    let httpError: unknown;
    try {
      await adapter.close();
    } catch (error) {
      httpFailed = true;
      httpError = error;
    }
    // Nest invokes provider destroy hooks before disposing its adapter. Drain the
    // adapter explicitly first so in-flight requests retain their database pool.
    try {
      if (app) await app.close();
    } catch (error) {
      if (!httpFailed) throw error;
      throw new AggregateError(
        [httpError, error],
        "Billing HTTP drain and provider cleanup failed",
        {
          // HTTP drain failure is primary; provider cleanup is secondary.
          // eslint-disable-next-line preserve-caught-error
          cause: httpError,
        },
      );
    }
    if (httpFailed) throw httpError;
  };
  try {
    app = await NestFactory.create<NestFastifyApplication>(
      AppModule.register(config),
      adapter,
      { logger: false, abortOnError: false },
    );
    await app.init();
    await adapter.getInstance().ready();
  } catch (error) {
    try {
      await destroy();
    } catch (cleanupError) {
      // Initialization/listen is primary; cleanup is secondary.
      throw new AggregateError(
        [error, cleanupError],
        "Billing initialization and cleanup failed",
        // eslint-disable-next-line preserve-caught-error
        { cause: error },
      );
    }
    throw error;
  }
  const application = app;
  let closing: Promise<void> | undefined;
  let starting: Promise<void> | undefined;
  let listening: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= (starting ?? Promise.resolve())
      .catch(() => undefined)
      .then(destroy);
    return closing;
  };
  return Object.freeze({
    listen: () => {
      if (closing)
        return Promise.reject(new Error("Billing runtime is closing"));
      if (!listening) {
        starting = application
          .listen(config.port, config.host)
          .then(() => undefined);
        listening = starting.catch(async (error: unknown) => {
          try {
            await close();
          } catch (cleanupError) {
            // Initialization/listen is primary; cleanup is secondary.
            throw new AggregateError(
              [error, cleanupError],
              "Billing listen and cleanup failed",
              // eslint-disable-next-line preserve-caught-error
              { cause: error },
            );
          }
          throw error;
        });
      }
      return listening;
    },
    close,
  });
}
