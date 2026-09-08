import { spawn } from "node:child_process";
const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
const isMissingProcess = (error: unknown) =>
  (error as NodeJS.ErrnoException).code === "ESRCH";
export async function runPrisma(
  args: string[],
  environment: NodeJS.ProcessEnv,
  timeoutMs = 60_000,
  entryPath = "node_modules/prisma/build/index.js",
): Promise<string> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    throw new RangeError("Prisma timeout must be a positive integer");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entryPath, ...args], {
      cwd: process.cwd(),
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let stdout = "";
    let settled = false;
    let timedOut = false;
    const finish = (error: Error | undefined, output = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(output);
    };
    const groupExists = () => {
      try {
        if (!child.pid) return false;
        process.kill(-child.pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const terminate = async () => {
      timedOut = true;
      const diagnostics: string[] = [];
      try {
        if (!child.pid) throw new Error("missing PID");
        process.kill(-child.pid, "SIGTERM");
      } catch (error) {
        if (!isMissingProcess(error)) diagnostics.push(String(error));
      }
      await delay(200);
      if (groupExists())
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch (error) {
          if (!isMissingProcess(error)) diagnostics.push(String(error));
        }
      for (let attempt = 0; attempt < 30 && groupExists(); attempt += 1)
        await delay(50);
      if (groupExists()) diagnostics.push("process group remained alive");
      finish(
        new Error(
          diagnostics.length
            ? `Prisma timeout cleanup failed: ${diagnostics.join("; ")}`
            : "Prisma command exceeded its time budget",
        ),
      );
    };
    const timer = setTimeout(() => {
      void terminate();
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.resume();
    child.on("error", () =>
      finish(new Error("Prisma command could not start")),
    );
    child.on("close", (code) => {
      if (timedOut) return;
      if (code === 0) finish(undefined, stdout);
      else
        finish(
          new Error(
            `Prisma command failed with exit code ${code ?? "unknown"}`,
          ),
        );
    });
  });
}
