import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const integration = describe.skipIf(!process.env.DATABASE_URL);

integration("PostgreSQL connection process lifecycle", () => {
  it.each([
    "checked-out-idle",
    "idle-pool",
    "nested-fatal",
    "report-idle",
    "control-BEGIN",
    "control-COMMIT",
    "control-ROLLBACK",
    "primary-falsey",
    "listener-lifecycle",
  ])(
    "%s rejects the operation without crashing and permits a new client",
    async (scenario) => {
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          fileURLToPath(
            new URL("./postgres-connection.fixture.ts", import.meta.url),
          ),
          scenario,
        ],
        {
          env: { ...process.env, POSTGRES_POOL_SIZE: "2" },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        stderr += chunk;
      });
      let spawnError: Error | undefined;
      const deadline = setTimeout(() => child.kill("SIGKILL"), 15_000);
      try {
        const result = await new Promise<{
          code: number | null;
          signal: NodeJS.Signals | null;
        }>((resolve) => {
          child.once("error", (error) => {
            spawnError = error;
          });
          child.once("close", (code, signal) => resolve({ code, signal }));
        });
        expect(spawnError).toBeUndefined();
        expect(result, stderr).toEqual({ code: 0, signal: null });
        expect(stdout).toContain(`completed:${scenario}`);
        console.log(stdout.trim());
        expect(stderr).not.toContain("Unhandled 'error'");
      } finally {
        clearTimeout(deadline);
      }
    },
  );
});
