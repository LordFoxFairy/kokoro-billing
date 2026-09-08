import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("verify-schema CLI errors", () => {
  it("does not print secrets from a malformed URL", () => {
    const secret = "TOKEN_DO_NOT_PRINT";
    const result = spawnSync(
      "pnpm",
      ["exec", "tsx", "scripts/verify-schema.ts"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          DATABASE_URL: `not-a-url-${secret}`,
          SCHEMA_ADMIN_URL: "postgresql://fixture@127.0.0.1:1/postgres",
        },
      },
    );
    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).not.toContain(secret);
    expect(result.stderr).toContain("schema verification failed");
  });
});
