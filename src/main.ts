import { createBillingRuntime } from "./bootstrap/create-billing-runtime.js";
import { readBillingRuntimeConfig } from "./config/runtime-config.js";

async function main(): Promise<void> {
  const config = readBillingRuntimeConfig();
  const runtime = await createBillingRuntime(config);

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = async (): Promise<void> => {
    if (shutdownPromise !== undefined) return shutdownPromise;
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `billing shutdown exceeded ${config.shutdownDeadlineMs}ms`,
            ),
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
    void shutdown().catch(() => {
      process.stderr.write(
        `kokoro-billing shutdown failed signal=${signal} category=shutdown_failed\n`,
      );
      process.exit(1);
    });
  };

  process.once("SIGTERM", () => handleSignal("SIGTERM"));
  process.once("SIGINT", () => handleSignal("SIGINT"));

  try {
    await runtime.listen();
  } catch (error) {
    try {
      await shutdown();
    } catch (cleanupError) {
      // Initialization/listen is primary; cleanup is secondary.
      throw new AggregateError(
        [error, cleanupError],
        "Billing startup and shutdown failed",
        // eslint-disable-next-line preserve-caught-error
        { cause: error },
      );
    }
    throw error;
  }
}
void main().catch(() => {
  process.stderr.write(
    "kokoro-billing startup failed category=startup_failed\n",
  );
  process.exitCode = 1;
});
