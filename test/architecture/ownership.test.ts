import { access, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { z } from 'zod';

const text = async (path: string): Promise<string> => readFile(join(process.cwd(), path), 'utf8');

const sourceFiles = async (directory: string): Promise<string[]> => {
  const entries = await readdir(join(process.cwd(), directory), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (entry.name.endsWith('.ts')) files.push(path);
  }
  return files;
};

const workflowSchema = z.object({
  jobs: z.object({
    publish: z.object({
      steps: z.array(z.object({
        name: z.string(),
        with: z.record(z.string(), z.unknown()).optional(),
      }).passthrough()),
    }).passthrough(),
  }).passthrough(),
}).passthrough();

describe('billing ownership architecture', () => {
  it('has one clean-slate schema and no retired implementation trees', async () => {
    await expect(access(join(process.cwd(), 'database/schema.sql'))).resolves.toBeUndefined();
    await expect(access(join(process.cwd(), 'database/migrations'))).rejects.toThrow();
    await expect(access(join(process.cwd(), 'scripts/apply-migrations.ts'))).rejects.toThrow();
    await expect(access(join(process.cwd(), 'src/modules'))).rejects.toThrow();
    await expect(access(join(process.cwd(), 'src/adapters'))).rejects.toThrow();
  });

  it('keeps application and domain code independent from infrastructure adapters', async () => {
    const files = [...await sourceFiles('src/domain'), ...await sourceFiles('src/application')];
    const contents = await Promise.all(files.map(async (path) => ({ path, content: await text(path) })));
    for (const { path, content } of contents) {
      expect(content, path).not.toMatch(/from ['"][^'"]*infrastructure\//u);
      expect(content, path).not.toMatch(/from ['"][^'"]*interfaces\//u);
    }
  });

  it('keeps SQL out of Application and Interfaces and database types out of Application', async () => {
    const applicationFiles = await sourceFiles('src/application');
    const files = [...applicationFiles, ...await sourceFiles('src/interfaces')];
    const sqlLiteral = /(?:`|"|')\s*(?:SELECT\b|INSERT\s+INTO\b|UPDATE\s+[a-z0-9_]+\s+SET\b|DELETE\s+FROM\b|WITH\s+[a-z0-9_]+\s+AS\b)/iu;
    for (const path of files) {
      const content = await text(path);
      expect(content, `${path} contains persistence SQL`).not.toMatch(sqlLiteral);
      if (applicationFiles.includes(path)) {
        expect(content, `${path} contains a database row or connection type`).not.toMatch(/\b(?:RowDataPacket|ResultSetHeader|PoolClient|QueryResultRow|Connection)\b/u);
        expect(content, `${path} imports a database implementation`).not.toMatch(/from ['"](?:pg|[^'"]*infrastructure\/postgres|[^'"]*ports\/database)[^'"]*['"]/u);
      }
    }
  });

  it('uses bounded-context repository ports and an explicit application transaction port', async () => {
    const expectedPorts = [
      'src/application/checkout/ports/checkout-repository.ts',
      'src/application/credit/ports/credit-repository.ts',
      'src/application/metering/ports/metering-repository.ts',
      'src/application/payment/ports/payment-repository.ts',
      'src/application/reconcile/ports/reconciliation-repository.ts',
      'src/application/refund/ports/refund-repository.ts',
      'src/application/subscription/ports/subscription-repository.ts',
      'src/application/ports/transaction.ts',
    ];
    await Promise.all(expectedPorts.map(async (path) => expect(access(join(process.cwd(), path)), path).resolves.toBeUndefined()));
    await expect(access(join(process.cwd(), 'src/application/ports/database.ts'))).rejects.toThrow();
  });

  it('tenant-qualifies every PostgreSQL repository join and never uses offset pagination', async () => {
    const repositoryFiles = await sourceFiles('src/infrastructure/postgres/repositories');
    for (const path of repositoryFiles) {
      const content = await text(path);
      expect(content, `${path} uses OFFSET pagination`).not.toMatch(/\bOFFSET\s+(?!:)/iu);
      const joins = content.matchAll(/\b(?:INNER\s+|LEFT\s+)?JOIN\s+(?:entitlement|payment)_[a-z0-9_]+\s+([a-z][a-z0-9_]*)\s+ON\s+([\s\S]*?)(?=\b(?:INNER\s+|LEFT\s+|RIGHT\s+|FULL\s+|CROSS\s+)?JOIN\b|\bWHERE\b|\bGROUP\s+BY\b|\bORDER\s+BY\b|\bLIMIT\b|`)/giu);
      for (const join of joins) {
        const alias = join[1];
        const on = join[2] ?? '';
        expect(on, `${path} join for alias ${alias} omits tenant lineage`).toMatch(new RegExp(`(?:${alias}\\.tenant_id\\s*=\\s*[a-z][a-z0-9_]*\\.tenant_id|[a-z][a-z0-9_]*\\.tenant_id\\s*=\\s*${alias}\\.tenant_id)`, 'iu'));
      }
    }
  });

  it('enables every Root TypeScript strictness option and explicit real-infrastructure workflow gates', async () => {
    const tsconfig = JSON.parse(await text('tsconfig.json')) as { compilerOptions?: Record<string, unknown> };
    for (const option of ['strict', 'noUncheckedIndexedAccess', 'exactOptionalPropertyTypes', 'noImplicitOverride', 'noImplicitReturns', 'noUnusedLocals', 'noUnusedParameters']) {
      expect(tsconfig.compilerOptions?.[option], option).toBe(true);
    }
    const eslint = await text('eslint.config.mjs');
    expect(eslint).not.toContain("'@typescript-eslint/no-explicit-any': 'off'");
    for (const workflow of ['.github/workflows/ci.yml', '.github/workflows/release-image.yml']) {
      expect(await text(workflow), workflow).toContain('pnpm test:integration');
    }
  });

  it('enforces bounded production I/O, structured redacted logs and supply-chain image gates', async () => {
    const runtimeConfig = await text('src/config/runtime-config.ts');
    const main = await text('src/main.ts');
    const redis = `${await text('src/infrastructure/redis/idempotency-hint.ts')}\n${await text('src/infrastructure/redis/lease.ts')}\n${await text('src/infrastructure/redis/timeout-policy.ts')}`;
    const stripe = await text('src/infrastructure/providers/stripe-checkout-provider.ts');
    const server = await text('src/interfaces/http/server.ts');
    const ci = await text('.github/workflows/ci.yml');
    const release = await text('.github/workflows/release-image.yml');

    expect(runtimeConfig).toContain('shutdownDeadlineMs');
    expect(main).toContain('shutdownDeadlineMs');
    for (const timeout of ['connectTimeoutMs', 'readTimeoutMs', 'overallTimeoutMs']) {
      expect(redis, timeout).toContain(timeout);
      expect(stripe, timeout).toContain(timeout);
    }
    expect(stripe).toContain('maxNetworkRetries: 1');
    expect(stripe).toContain('idempotencyKey');
    expect(server).toContain('redact:');
    for (const field of ['service', 'operation', 'request_id', 'trace_id', 'result', 'duration_ms']) {
      expect(server, field).toContain(field);
    }
    expect(release).toContain('sbom: true');
    expect(release).toContain('provenance: mode=max');
    expect(release).toContain('aquasecurity/trivy-action');
    expect(release).toContain('cosign sign');
    expect(ci).toContain('scanners: vuln,misconfig,secret');

    const publishSteps = workflowSchema.parse(parse(release)).jobs.publish.steps;
    const stepIndex = (name: string): number => publishSteps.findIndex((step) => step.name === name);
    const candidateIndex = stepIndex('Build local release candidate');
    const scanIndex = stepIndex('Scan release candidate');
    const smokeIndex = stepIndex('Smoke-test release candidate');
    const pushIndex = stepIndex('Build and push production image');
    expect(candidateIndex).toBeGreaterThanOrEqual(0);
    expect(scanIndex).toBeGreaterThan(candidateIndex);
    expect(smokeIndex).toBeGreaterThan(scanIndex);
    expect(pushIndex).toBeGreaterThan(smokeIndex);
    expect(publishSteps[candidateIndex]?.with).toMatchObject({ load: true, push: false });
    expect(publishSteps[scanIndex]?.with).toMatchObject({
      scanners: 'vuln',
      'exit-code': '1',
      'ignore-unfixed': true,
      severity: 'HIGH,CRITICAL',
    });
    expect(publishSteps[pushIndex]?.with).toMatchObject({ push: true, sbom: true, provenance: 'mode=max' });

    for (const [workflow, content] of [['ci', ci], ['release', release]] as const) {
      for (const action of content.matchAll(/\buses:\s*([^\s#]+)/gu)) {
        expect(action[1], `${workflow} action is not immutable`).toMatch(/@[0-9a-f]{40}$/u);
      }
    }
  });

  it('keeps transport aliases and test doubles outside production composition', async () => {
    const server = await text('src/interfaces/http/server.ts');
    const main = await text('src/main.ts');
    const bootstrap = await text('src/bootstrap/create-billing-runtime.ts');
    const production = (await Promise.all((await sourceFiles('src')).map(text))).join('\n');
    expect(server).not.toContain("'/billing/redeem'");
    expect(server).not.toContain("'/admin/billing/redeem-campaigns'");
    expect(main).not.toContain('new RedeemService');
    expect(main).not.toContain('new RedeemAdminService');
    expect(main).toContain('createBillingRuntime');
    expect(main).not.toContain('createBillingConnection');
    expect(bootstrap).toContain('createBillingConnection');
    expect(bootstrap).toContain('createBillingServer');
    expect(production).not.toMatch(/MockWebhookProvider|mock-checkout|InMemory|Fixture|Fake/u);
  });

  it('uses explicit PostgreSQL SQL and UTC precision in the canonical schema', async () => {
    const schema = await text('database/schema.sql');
    expect(schema).not.toMatch(/\bFOREIGN\s+KEY\b|\bREFERENCES\b/iu);
    expect(schema).not.toMatch(/\bTIMESTAMP(?:\s*\(|\s+WITH|\s+WITHOUT)\b/iu);
    expect(schema).not.toMatch(/TIMESTAMPTZ\((?!3\))/iu);
    expect(schema).not.toMatch(/\bSELECT\s+\*/iu);
    expect(schema).toContain('CREATE TABLE IF NOT EXISTS entitlement_credit_journal');
    expect(schema).toContain('CREATE TABLE IF NOT EXISTS payment_command_receipt');
  });
});
