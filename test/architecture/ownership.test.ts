import { createHash } from "node:crypto";
import { access, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";
import { format } from "prettier";
import { readBillingDependencyGraph } from "./typescript-dependency-project.js";
import { checkBillingDependencies } from "./billing-dependency-policy.js";

const retiredRoutes = ["/billing/redeem", "/admin/billing/redeem-campaigns"];
function assertNoRetiredRoutes(source: string): void {
  for (const route of retiredRoutes) {
    if (new RegExp(`["']${route}["']`, "u").test(source))
      throw new Error(`retired-route:${route}`);
  }
}
function assertNoExplicitAnyDisable(source: string): void {
  if (
    /['"]@typescript-eslint\/no-explicit-any['"]\s*:\s*['"]off['"]/u.test(
      source,
    )
  )
    throw new Error("explicit-any-disabled");
}

const text = async (path: string): Promise<string> =>
  readFile(join(process.cwd(), path), "utf8");

const sourceFiles = async (directory: string): Promise<string[]> => {
  const entries = await readdir(join(process.cwd(), directory), {
    withFileTypes: true,
  });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
    else if (entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
};

const workflowSchema = z
  .object({
    jobs: z
      .object({
        publish: z
          .object({
            steps: z.array(
              z
                .object({
                  name: z.string(),
                  with: z.record(z.string(), z.unknown()).optional(),
                })
                .passthrough(),
            ),
          })
          .passthrough(),
      })
      .passthrough(),
  })
  .passthrough();

const openApiSchema = z
  .object({
    paths: z.record(z.string(), z.record(z.string(), z.unknown())),
  })
  .passthrough();

const operationGovernance: Readonly<
  Record<string, Readonly<{ idempotency: string; permission: string }>>
> = {
  "get /healthz": { idempotency: "inherent", permission: "none" },
  "get /readyz": { idempotency: "inherent", permission: "none" },
  "get /metrics": { idempotency: "inherent", permission: "none" },
  "get /v1/commerce/catalog": {
    idempotency: "read-only",
    permission: "authenticated-user-or-web-bff",
  },
  "get /v1/billing/me/credit-account": {
    idempotency: "read-only",
    permission: "authenticated-user",
  },
  "get /v1/billing/me/credit-ledger": {
    idempotency: "read-only",
    permission: "authenticated-user",
  },
  "post /v1/internal/entitlement/admissions": {
    idempotency: "required",
    permission: "agent-model-studio-service",
  },
  "post /v1/internal/entitlement/admissions/{admissionId}/capture": {
    idempotency: "required",
    permission: "agent-model-studio-service",
  },
  "post /v1/internal/entitlement/admissions/{admissionId}/release": {
    idempotency: "required",
    permission: "agent-model-studio-service",
  },
  "post /v1/internal/billing/execution-events": {
    idempotency: "required",
    permission: "agent-model-studio-service",
  },
  "post /v1/internal/payment/settlements/accept": {
    idempotency: "required",
    permission: "payment-worker-or-scheduler",
  },
  "post /v1/internal/payment/refunds/accept": {
    idempotency: "required",
    permission: "payment-worker-service",
  },
  "post /v1/internal/commands/expire-credit-holds": {
    idempotency: "required",
    permission: "scheduler-service",
  },
  "post /v1/webhooks/payment/{provider}": {
    idempotency: "provider-event-id",
    permission: "provider-signature",
  },
  "get /v1/billing/me/subscriptions": {
    idempotency: "read-only",
    permission: "authenticated-user",
  },
  "post /v1/billing/checkout": {
    idempotency: "required",
    permission: "authenticated-user-or-web-bff",
  },
  "post /v1/admin/billing/refunds": {
    idempotency: "required",
    permission: "billing-admin",
  },
};

describe("billing ownership architecture", () => {
  it("keeps the repository governance document set and a local ADR", async () => {
    const requiredDocuments = [
      "README.md",
      "INDEX.md",
      "docs/INDEX.md",
      "docs/CURRENT.md",
      "docs/TECHNICAL_DESIGN.md",
      "docs/API_CONTRACT.md",
      "docs/DATA_MODEL.md",
      "docs/SECURITY.md",
      "docs/RELIABILITY.md",
      "docs/ACCEPTANCE.md",
      "docs/SLO.md",
      "docs/RUNBOOK.md",
      "contract/README.md",
    ];
    await Promise.all(
      requiredDocuments.map(async (path) =>
        expect(
          access(join(process.cwd(), path)),
          path,
        ).resolves.toBeUndefined(),
      ),
    );
    const adrFiles = (await readdir(join(process.cwd(), "docs/ADR"))).filter(
      (entry) => entry.endsWith(".md"),
    );
    expect(adrFiles).not.toHaveLength(0);
  });

  it("governs every OpenAPI operation with exact owner semantics", async () => {
    const contract = openApiSchema.parse(
      parse(await text("contract/openapi/v1/openapi.yaml")),
    );
    const actualOperations = new Set<string>();
    for (const [path, pathItem] of Object.entries(contract.paths)) {
      for (const [method, rawOperation] of Object.entries(pathItem)) {
        const key = `${method.toLowerCase()} ${path}`;
        const expected = operationGovernance[key];
        if (expected === undefined) continue;
        actualOperations.add(key);
        const operation = z.record(z.string(), z.unknown()).parse(rawOperation);
        expect(operation, key).toMatchObject({
          "x-kokoro-owner": "kokoro-billing",
          "x-kokoro-visibility": "internal-owner",
          "x-kokoro-stability": "stable",
          "x-kokoro-idempotency": expected.idempotency,
          "x-kokoro-permission": expected.permission,
        });
      }
    }
    expect([...actualOperations].sort()).toEqual(
      Object.keys(operationGovernance).sort(),
    );
  });

  it("binds contract governance documentation to the current OpenAPI digest", async () => {
    const source = await text("contract/openapi/v1/openapi.yaml");
    const readme = await text("contract/README.md");
    const digest = createHash("sha256").update(source).digest("hex");
    expect(readme).toContain(digest);
    for (const field of [
      "owner",
      "visibility",
      "version",
      "generation",
      "breaking",
      "provenance",
      "consumer workflow",
    ]) {
      expect(readme.toLowerCase(), field).toContain(field);
    }
  });

  it("has one clean-slate schema and no retired implementation trees", async () => {
    await expect(
      access(join(process.cwd(), "database/schema.sql")),
    ).resolves.toBeUndefined();
    await expect(
      access(join(process.cwd(), "database/migrations")),
    ).rejects.toThrow();
    await expect(
      access(join(process.cwd(), "scripts/apply-migrations.ts")),
    ).rejects.toThrow();
    await expect(access(join(process.cwd(), "src/adapters"))).rejects.toThrow();
  });

  it("enforces resolved production boundaries and reports the fixed B8 type debt", async () => {
    const graph = await readBillingDependencyGraph();
    expect(checkBillingDependencies(graph)).toEqual([]);
    expect(graph.cycles.value).toEqual([]);
    expect(graph.cycles.type).toHaveLength(7);
    expect(graph.cycles.all).toEqual(graph.cycles.type);
  });

  it("keeps SQL out of Application and Interfaces and database types out of Application", async () => {
    await expect(
      access(join(process.cwd(), "src/application/ports/database.ts")),
    ).rejects.toThrow();
    const applicationFiles = await sourceFiles("src/application");
    const files = [
      ...applicationFiles,
      ...(await sourceFiles("src/interfaces")),
    ];
    const sqlLiteral =
      /(?:`|"|')\s*(?:SELECT\b|INSERT\s+INTO\b|UPDATE\s+[a-z0-9_]+\s+SET\b|DELETE\s+FROM\b|WITH\s+[a-z0-9_]+\s+AS\b)/iu;
    for (const path of files) {
      const content = await text(path);
      expect(content, `${path} contains persistence SQL`).not.toMatch(
        sqlLiteral,
      );
      if (applicationFiles.includes(path)) {
        expect(
          content,
          `${path} contains a database row or connection type`,
        ).not.toMatch(
          /\b(?:RowDataPacket|ResultSetHeader|PoolClient|QueryResultRow|Connection)\b/u,
        );
      }
    }
  });

  it("tenant-qualifies every PostgreSQL repository join and never uses offset pagination", async () => {
    const repositoryFiles = await sourceFiles(
      "src/infrastructure/postgres/repositories",
    );
    for (const path of repositoryFiles) {
      const content = await text(path);
      expect(content, `${path} uses OFFSET pagination`).not.toMatch(
        /\bOFFSET\s+(?!:)/iu,
      );
      const joins = content.matchAll(
        /\b(?:INNER\s+|LEFT\s+)?JOIN\s+(?:entitlement|payment)_[a-z0-9_]+\s+([a-z][a-z0-9_]*)\s+ON\s+([\s\S]*?)(?=\b(?:INNER\s+|LEFT\s+|RIGHT\s+|FULL\s+|CROSS\s+)?JOIN\b|\bWHERE\b|\bGROUP\s+BY\b|\bORDER\s+BY\b|\bLIMIT\b|`)/giu,
      );
      for (const join of joins) {
        const alias = join[1];
        const on = join[2] ?? "";
        expect(
          on,
          `${path} join for alias ${alias} omits tenant lineage`,
        ).toMatch(
          new RegExp(
            `(?:${alias}\\.tenant_id\\s*=\\s*[a-z][a-z0-9_]*\\.tenant_id|[a-z][a-z0-9_]*\\.tenant_id\\s*=\\s*${alias}\\.tenant_id)`,
            "iu",
          ),
        );
      }
    }
  });

  it("enables every Root TypeScript strictness option and explicit real-infrastructure workflow gates", async () => {
    const tsconfig = JSON.parse(await text("tsconfig.json")) as {
      compilerOptions?: Record<string, unknown>;
    };
    for (const option of [
      "strict",
      "noUncheckedIndexedAccess",
      "exactOptionalPropertyTypes",
      "noImplicitOverride",
      "noImplicitReturns",
      "noUnusedLocals",
      "noUnusedParameters",
      "useUnknownInCatchVariables",
    ]) {
      expect(tsconfig.compilerOptions?.[option], option).toBe(true);
    }
    const eslint = await text("eslint.config.mjs");
    assertNoExplicitAnyDisable(eslint);
    for (const workflow of [
      ".github/workflows/ci.yml",
      ".github/workflows/release-image.yml",
    ]) {
      expect(await text(workflow), workflow).toContain("pnpm test:integration");
    }
  });

  it("enforces bounded production I/O, structured redacted logs and supply-chain image gates", async () => {
    const runtimeConfig = await text("src/config/runtime-config.ts");
    const main = await text("src/main.ts");
    const redis = `${await text("src/infrastructure/redis/idempotency-hint.ts")}\n${await text("src/infrastructure/redis/lease.ts")}\n${await text("src/infrastructure/redis/timeout-policy.ts")}`;
    const stripe = await text(
      "src/infrastructure/providers/stripe-checkout-provider.ts",
    );
    const server = await text("src/interfaces/http/server.ts");
    const ci = await text(".github/workflows/ci.yml");
    const release = await text(".github/workflows/release-image.yml");

    expect(runtimeConfig).toContain("shutdownDeadlineMs");
    expect(main).toContain("shutdownDeadlineMs");
    for (const timeout of [
      "connectTimeoutMs",
      "readTimeoutMs",
      "overallTimeoutMs",
    ]) {
      expect(redis, timeout).toContain(timeout);
      expect(stripe, timeout).toContain(timeout);
    }
    expect(stripe).toContain("maxNetworkRetries: 1");
    expect(stripe).toContain("idempotencyKey");
    expect(server).toContain("redact:");
    for (const field of [
      "service",
      "operation",
      "request_id",
      "trace_id",
      "result",
      "duration_ms",
    ]) {
      expect(server, field).toContain(field);
    }
    expect(release).toContain("sbom: true");
    expect(release).toContain("provenance: mode=max");
    expect(release).toContain("aquasecurity/trivy-action");
    expect(release).toContain("cosign sign");
    expect(ci).toContain("scanners: vuln,misconfig,secret");

    const publishSteps = workflowSchema.parse(parse(release)).jobs.publish
      .steps;
    const stepIndex = (name: string): number =>
      publishSteps.findIndex((step) => step.name === name);
    const candidateIndex = stepIndex("Build local release candidate");
    const scanIndex = stepIndex("Scan release candidate");
    const smokeIndex = stepIndex("Smoke-test release candidate");
    const pushIndex = stepIndex("Build and push production image");
    expect(candidateIndex).toBeGreaterThanOrEqual(0);
    expect(scanIndex).toBeGreaterThan(candidateIndex);
    expect(smokeIndex).toBeGreaterThan(scanIndex);
    expect(pushIndex).toBeGreaterThan(smokeIndex);
    expect(publishSteps[candidateIndex]?.with).toMatchObject({
      load: true,
      push: false,
    });
    expect(publishSteps[scanIndex]?.with).toMatchObject({
      scanners: "vuln",
      "exit-code": "1",
      "ignore-unfixed": true,
      severity: "HIGH,CRITICAL",
    });
    expect(publishSteps[pushIndex]?.with).toMatchObject({
      push: true,
      sbom: true,
      provenance: "mode=max",
    });

    for (const [workflow, content] of [
      ["ci", ci],
      ["release", release],
    ] as const) {
      for (const action of content.matchAll(/\buses:\s*([^\s#]+)/gu)) {
        expect(action[1], `${workflow} action is not immutable`).toMatch(
          /@[0-9a-f]{40}$/u,
        );
      }
    }
  });

  it("keeps transport aliases and test doubles outside production composition", async () => {
    const server = await text("src/interfaces/http/server.ts");
    const main = await text("src/main.ts");
    const bootstrap = await text("src/bootstrap/create-billing-runtime.ts");
    const production = (
      await Promise.all((await sourceFiles("src")).map(text))
    ).join("\n");
    assertNoRetiredRoutes(server);
    expect(main).not.toContain("new RedeemService");
    expect(main).not.toContain("new RedeemAdminService");
    expect(main).toContain("createBillingRuntime");
    expect(main).not.toContain("createBillingConnection");
    expect(bootstrap).toContain("createBillingConnection");
    expect(bootstrap).toContain("createBillingServer");
    expect(production).not.toMatch(
      /MockWebhookProvider|mock-checkout|InMemory|Fixture|Fake/u,
    );
  });

  it("uses explicit PostgreSQL SQL and UTC precision in the canonical schema", async () => {
    const schema = await text("database/schema.sql");
    expect(schema).not.toMatch(/\bFOREIGN\s+KEY\b|\bREFERENCES\b/iu);
    expect(schema).not.toMatch(/\bTIMESTAMP(?:\s*\(|\s+WITH|\s+WITHOUT)\b/iu);
    expect(schema).not.toMatch(/TIMESTAMPTZ\((?!3\))/iu);
    expect(schema).not.toMatch(/\bSELECT\s+\*/iu);
    expect(schema).toContain(
      "CREATE TABLE IF NOT EXISTS billing_credit_journal",
    );
    expect(schema).toContain(
      "CREATE TABLE IF NOT EXISTS billing_command_receipt",
    );
    expect(schema).toContain("uq_billing_command_receipt_identity");
    expect(schema).not.toMatch(
      /CREATE TABLE IF NOT EXISTS (?:payment|entitlement)_command_receipt/u,
    );
  });
});

describe("format-independent source governance", () => {
  it.each(retiredRoutes)(
    "rejects retired route %s before and after formatting",
    async (route) => {
      expect(() =>
        assertNoRetiredRoutes('app.post("/v1/billing/checkout", handler);'),
      ).not.toThrow();
      const source = `app.post('${route}', handler);`;
      expect(() => assertNoRetiredRoutes(source)).toThrow(
        `retired-route:${route}`,
      );
      const formatted = await format(source, { parser: "typescript" });
      expect(() => assertNoRetiredRoutes(formatted)).toThrow(
        `retired-route:${route}`,
      );
    },
  );
  it("rejects explicit-any disabling independently of quote and whitespace style", async () => {
    expect(() =>
      assertNoExplicitAnyDisable(
        'export default { "@typescript-eslint/no-explicit-any": "error" };',
      ),
    ).not.toThrow();
    const source =
      "export default { '@typescript-eslint/no-explicit-any': 'off' };";
    expect(() => assertNoExplicitAnyDisable(source)).toThrow(
      "explicit-any-disabled",
    );
    const formatted = await format(source, { parser: "babel" });
    expect(() => assertNoExplicitAnyDisable(formatted)).toThrow(
      "explicit-any-disabled",
    );
  });
});
