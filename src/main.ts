import { createBillingRuntime } from "./bootstrap/create-billing-runtime.js";
import { readBillingRuntimeConfig } from "./config/runtime-config.js";

const config = readBillingRuntimeConfig();
const runtime = await createBillingRuntime(config);

await runtime.server.listen({ host: config.host, port: config.port });

let shutdownPromise: Promise<void> | undefined;
const shutdown = async (): Promise<void> => {
  if (shutdownPromise !== undefined) return shutdownPromise;
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(`billing shutdown exceeded ${config.shutdownDeadlineMs}ms`),
        ),
      config.shutdownDeadlineMs,
    );
  });
  shutdownPromise = Promise.race([runtime.close(), deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
  return shutdownPromise;
};

const handleSignal = (signal: NodeJS.Signals): void => {
  void shutdown().catch((error: unknown) => {
    process.stderr.write(
      `kokoro-billing shutdown failed signal=${signal} error=${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
};

process.once("SIGTERM", () => handleSignal("SIGTERM"));
process.once("SIGINT", () => handleSignal("SIGINT"));
