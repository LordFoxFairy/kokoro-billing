import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { Test } from "@nestjs/testing";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { DatabaseModule } from "../../src/database/database.module.js";
import { BillingHttpModule } from "../../src/http/billing-http.module.js";
import { CreditService } from "../../src/modules/credit/credit.service.js";
import { AuditAppender } from "../../src/database/audit-appender.js";
import { createPrismaDatabaseFixture } from "./prisma-database.fixture.js";
import type { PrismaDatabaseFixture } from "./prisma-database.fixture.js";
const admin = process.env.SCHEMA_ADMIN_URL;
const path = "/v2/billing/me/credit-account";
const auth = {
  mode: "jwks" as const,
  internalServiceSecret: "opening-pg-internal-secret-000000001",
  bffServiceToken: "opening-pg-bff-service-token-0000001",
  operatorProxySecret: "opening-pg-operator-secret-00000001",
  jwksUrl: "https://iam.example.test/iam/jwks",
  issuer: "https://iam.example.test/iam",
  audience: "https://kokoro.dev/resources/billing",
};
describe.skipIf(!admin)("real PG explicit own credit opening", () => {
  let fixture: PrismaDatabaseFixture;
  let app: NestFastifyApplication;
  let credit: CreditService;
  beforeAll(async () => {
    if (!admin) throw new Error("SCHEMA_ADMIN_URL required");
    fixture = await createPrismaDatabaseFixture(admin);
    const module = await Test.createTestingModule({
      imports: [
        DatabaseModule.register({ databaseUrl: fixture.url }),
        BillingHttpModule.register(auth),
      ],
    }).compile();
    app = module.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
      { logger: false },
    );
    await app.init();
    credit = app.get(CreditService);
  });
  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      await fixture?.close();
    }
  });
  const identity = () => ({ tenantId: randomUUID(), subjectId: randomUUID() });
  const headers = (context: ReturnType<typeof identity>) => ({
    authorization: `Bearer ${auth.bffServiceToken}`,
    "content-type": "application/json",
    "x-kokoro-service": "web-bff",
    "x-kokoro-internal-secret": auth.internalServiceSecret,
    "x-kokoro-tenant-id":
      "u1." + Buffer.from(context.tenantId).toString("base64url"),
    "x-kokoro-subject":
      "u1." + Buffer.from(context.subjectId).toString("base64url"),
  });
  const open = (context: ReturnType<typeof identity>) =>
    app.inject({
      method: "PUT",
      url: path,
      headers: headers(context),
      payload: "{}",
    });
  const facts = async () => {
    const tables = await fixture.pool.query<{ name: string }>(
      "SELECT tablename AS name FROM pg_tables WHERE schemaname='kokoro_billing' ORDER BY tablename",
    );
    expect(tables.rows).toHaveLength(35);
    return Object.fromEntries(
      await Promise.all(
        tables.rows.map(async ({ name }) => {
          if (!/^[a-z][a-z0-9_]*$/u.test(name))
            throw new Error("Invalid fixture table");
          const rows = await fixture.pool.query<{ row: string }>(
            `SELECT to_jsonb(t)::text AS row FROM kokoro_billing."${name}" t ORDER BY to_jsonb(t)::text COLLATE "C"`,
          );
          return [name, rows.rows.map((row) => row.row)] as const;
        }),
      ),
    );
  };
  it("opens by real HTTP; only account and first audit change across all35 tables; replay/GET reconcile do not write", async () => {
    const own = identity();
    const before = await facts();
    expect(
      (await app.inject({ method: "GET", url: path, headers: headers(own) }))
        .statusCode,
    ).toBe(404);
    const first = await open(own);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      data: { available_micros: "0", held_micros: "0" },
    });
    const after = await facts();
    for (const name of Object.keys(before))
      if (!["billing_credit_account", "billing_audit_event"].includes(name))
        expect(after[name], name).toEqual(before[name]);
    expect(after.billing_credit_account?.length).toBe(
      (before.billing_credit_account?.length ?? 0) + 1,
    );
    expect(after.billing_audit_event?.length).toBe(
      (before.billing_audit_event?.length ?? 0) + 1,
    );
    const audit = await fixture.client.billing_audit_event.findFirstOrThrow({
      where: { tenant_id: own.tenantId, subject_id: own.subjectId },
    });
    expect(audit.operator_id).toBe("web-bff");
    expect(audit.action).toBe("credit.account_open");
    // A consumer may lose the first ACK; read the owner, then explicitly replay PUT.
    const read = await app.inject({
      method: "GET",
      url: path,
      headers: headers(own),
    });
    expect(read.json()).toEqual(first.json());
    expect((await open(own)).json()).toEqual(first.json());
    expect(await facts()).toEqual(after);
  });
  it("serializes concurrent opening and isolates same subject in another tenant", async () => {
    const own = identity();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => open(own)),
    );
    for (const result of results) {
      expect(result.statusCode).toBe(200);
      expect(result.json()).toEqual(results[0]?.json());
    }
    expect(
      await fixture.client.billing_credit_account.count({
        where: { tenant_id: own.tenantId, subject_id: own.subjectId },
      }),
    ).toBe(1);
    expect(
      await fixture.client.billing_audit_event.count({
        where: { tenant_id: own.tenantId, subject_id: own.subjectId },
      }),
    ).toBe(1);
    const other = { ...own, tenantId: randomUUID() };
    expect((await open(other)).statusCode).toBe(200);
    expect(
      await fixture.client.billing_credit_account.count({
        where: { subject_id: own.subjectId },
      }),
    ).toBe(2);
  });
  it("preserves existing nonzero/generation/timestamps, and never revives disabled", async () => {
    const own = identity();
    await open(own);
    const original =
      await fixture.client.billing_credit_account.findFirstOrThrow({
        where: { tenant_id: own.tenantId },
      });
    await fixture.client.billing_credit_account.update({
      where: { id: original.id },
      data: { available_micros: 91n, held_micros: 7n, generation: 8n },
    });
    const before = await facts();
    expect((await open(own)).json()).toMatchObject({
      data: { available_micros: "91", held_micros: "7" },
    });
    expect(await facts()).toEqual(before);
    await fixture.client.billing_credit_account.update({
      where: { id: original.id },
      data: { status: "disabled" },
    });
    const disabled = await facts();
    const response = await open(own);
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: { code: "billing.credit_account_disabled", retryable: false },
    });
    expect(await facts()).toEqual(disabled);
  });
  it("rolls the account back if first audit fails", async () => {
    const own = identity();
    const before = await facts();
    const spy = vi
      .spyOn(app.get(AuditAppender), "append")
      .mockRejectedValueOnce(new Error("owned audit failure"));
    try {
      expect((await open(own)).statusCode).toBe(500);
      expect(await facts()).toEqual(before);
    } finally {
      spy.mockRestore();
    }
  });
  it("coordinates with the real grant path under its same subject lock", async () => {
    const own = identity();
    const key = randomUUID();
    const [opened] = await Promise.all([
      open(own),
      credit.grant({
        ...own,
        actorId: "fixture",
        reason: "Owned concurrency verification",
        amountMicros: 31n,
        sourceKind: "fixture",
        sourceRef: key,
        programKey: "fixture",
        effectiveAt: new Date(),
        idempotencyKey: key,
        commandIdentity: key,
      }),
    ]);
    expect(opened.statusCode).toBe(200);
    const row = await fixture.client.billing_credit_account.findFirstOrThrow({
      where: { tenant_id: own.tenantId, subject_id: own.subjectId },
    });
    expect(row.available_micros).toBe(31n);
    expect(
      await fixture.client.billing_credit_account.count({
        where: { tenant_id: own.tenantId, subject_id: own.subjectId },
      }),
    ).toBe(1);
  });
  it("returns bounded lock failure with a genuine rollback, then allows explicit retry", async () => {
    const own = identity();
    const lock = await fixture.pool.connect();
    const before = await facts();
    try {
      await lock.query("BEGIN");
      await lock.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `credit:subject:${own.tenantId}:${own.subjectId}`,
      ]);
      const started = performance.now();
      const response = await open(own);
      expect(response.statusCode).toBe(503);
      expect(performance.now() - started).toBeLessThan(10000);
      expect(await facts()).toEqual(before);
    } finally {
      await lock.query("ROLLBACK");
      lock.release();
    }
    expect((await open(own)).statusCode).toBe(200);
  });
  it("rejects untrusted or invalid HTTP before any durable owner fact", async () => {
    const own = identity();
    const before = await facts();
    for (const request of [
      {
        headers: { ...headers(own), authorization: "Bearer forged" },
        payload: "{}",
      },
      {
        headers: { ...headers(own), "x-kokoro-subject": "not-canonical" },
        payload: "{}",
      },
      { headers: headers(own), payload: '{"amount_micros":"0"}' },
    ]) {
      const response = await app.inject({
        method: "PUT",
        url: path,
        ...request,
      });
      expect([400, 403]).toContain(response.statusCode);
      expect(await facts()).toEqual(before);
    }
  });
});
