import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { Test } from "@nestjs/testing";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseModule } from "../../src/database/database.module.js";
import { BillingHttpModule } from "../../src/http/billing-http.module.js";
import {
  createPrismaDatabaseFixture,
  type PrismaDatabaseFixture,
} from "./prisma-database.fixture.js";

const admin = process.env.SCHEMA_ADMIN_URL;
describe.skipIf(admin === undefined)(
  "SET15 canonical Catalog real owner PostgreSQL",
  () => {
    let fixture: PrismaDatabaseFixture;
    let app: NestFastifyApplication;
    const auth = {
      mode: "jwks" as const,
      internalServiceSecret: "set15-catalog-internal-secret-000001",
      bffServiceToken: "set15-catalog-machine-bearer-0000001",
      operatorProxySecret: "set15-catalog-operator-secret-000001",
      issuer: "https://iam.example.test/iam",
      audience: "https://kokoro.dev/resources/billing",
      jwksUrl: "http://127.0.0.1:1/unused",
    };
    const headers = (tenant: string) => ({
      authorization: `Bearer ${auth.bffServiceToken}`,
      "x-kokoro-service": "web-bff",
      "x-kokoro-internal-secret": auth.internalServiceSecret,
      "x-kokoro-tenant-id": "u1." + Buffer.from(tenant).toString("base64url"),
    });
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
    });
    afterAll(async () => {
      try {
        if (app) await app.close();
      } finally {
        if (fixture) await fixture.close();
      }
    });
    async function facts() {
      const tables = await fixture.pool.query<{ name: string }>(
        "SELECT tablename AS name FROM pg_tables WHERE schemaname='kokoro_billing' ORDER BY tablename",
      );
      expect(tables.rows).toHaveLength(35);
      return Promise.all(
        tables.rows.map(async ({ name }) => {
          if (!/^[a-z][a-z0-9_]*$/u.test(name))
            throw new Error("Invalid fixture table");
          const result = await fixture.pool.query<{ row: string }>(
            `SELECT to_jsonb(t)::text AS row FROM kokoro_billing."${name}" t ORDER BY to_jsonb(t)::text COLLATE "C"`,
          );
          return { name, rows: result.rows };
        }),
      );
    }
    async function offer(tenant: string, key: string, status = "active") {
      return fixture.client.billing_offer.create({
        data: { id: randomUUID(), tenant_id: tenant, offer_key: key, status },
      });
    }
    async function revision(
      tenant: string,
      offerId: string,
      number: number,
      patch: {
        status?: string;
        deleted_at?: Date;
        published_at?: Date;
        name?: string;
      } = {},
    ) {
      return fixture.client.billing_offer_revision.create({
        data: {
          id: randomUUID(),
          tenant_id: tenant,
          offer_id: offerId,
          revision: number,
          name: "Fixture plan",
          amount_minor: 9007199254740993n,
          credit_micros: 9223372036854775807n,
          currency_code: "USD",
          billing_interval: "month",
          status: "published",
          published_at: new Date("2020-01-01T00:00:00Z"),
          ...patch,
        },
      });
    }
    async function get(tenant: string, suffix = "") {
      return app.inject({
        method: "GET",
        url: "/v1/commerce/catalog" + suffix,
        headers: headers(tenant),
      });
    }
    it("selects the latest eligible revision without hiding it behind draft/disabled/deleted/future revisions, and reads zero writes", async () => {
      const tenant = randomUUID();
      const parent = await offer(tenant, "a-plan");
      await revision(tenant, parent.id, 1);
      const latest = await revision(tenant, parent.id, 2);
      await revision(tenant, parent.id, 3, { status: "draft" });
      await revision(tenant, parent.id, 4, { status: "disabled" });
      await revision(tenant, parent.id, 5, { deleted_at: new Date() });
      await revision(tenant, parent.id, 6, {
        published_at: new Date("2999-01-01T00:00:00Z"),
      });
      const disabled = await offer(tenant, "disabled", "disabled");
      await revision(tenant, disabled.id, 1);
      const other = await offer(randomUUID(), "other-tenant");
      await revision(other.tenant_id, other.id, 1);
      const before = await facts();
      const response = await get(tenant);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        data: {
          items: [
            {
              offer_key: "a-plan",
              offer_revision_id: latest.id,
              name: "Fixture plan",
              amount_minor: "9007199254740993",
              credit_micros: "9223372036854775807",
              currency_code: "USD",
              billing_interval: "month",
            },
          ],
          page: { next_cursor: null },
        },
      });
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["x-request-id"]).toBeTruthy();
      expect(await facts()).toEqual(before);
    });
    it("paginates in stable C order, binds cursor tenant/scope, and rejects bad queries without writes", async () => {
      const tenant = randomUUID();
      const keys = ["z", "a", "😀"];
      for (const key of keys) {
        const parent = await offer(tenant, key);
        await revision(tenant, parent.id, 1);
      }
      const before = await facts();
      let cursor: string | null = null;
      let firstCursor = "";
      const found: string[] = [];
      for (let index = 0; index < 3; index++) {
        const response = await get(
          tenant,
          "?limit=1" + (cursor ? "&cursor=" + cursor : ""),
        );
        expect(response.statusCode).toBe(200);
        const body = response.json<{
          data: {
            items: { offer_key: string }[];
            page: { next_cursor: string | null };
          };
        }>();
        expect(body.data.items).toHaveLength(1);
        const item = body.data.items[0];
        if (!item) throw new Error("Missing fixture page item");
        found.push(item.offer_key);
        cursor = body.data.page.next_cursor;
        if (index === 0) {
          if (!cursor) throw new Error("Missing fixture next cursor");
          firstCursor = cursor;
        }
      }
      expect(found).toEqual(["a", "z", "😀"]);
      expect(cursor).toBeNull();
      expect(
        (await get(randomUUID(), "?cursor=" + firstCursor)).statusCode,
      ).toBe(400);
      for (const suffix of [
        "?limit=101",
        "?limit=1&limit=2",
        "?cursor=A",
        "?offset=1",
      ])
        expect((await get(tenant, suffix)).statusCode).toBe(400);
      expect(await facts()).toEqual(before);
    });
    it.each(["missing", "foreign-tenant"])(
      "fails closed for an otherwise eligible %s parent rather than silently returning empty",
      async (kind) => {
        const tenant = randomUUID();
        const parentId =
          kind === "missing"
            ? randomUUID()
            : (await offer(randomUUID(), "foreign")).id;
        await revision(tenant, parentId, 1);
        const before = await facts();
        const response = await get(tenant);
        expect(response.statusCode).toBe(500);
        expect(response.json()).toMatchObject({
          error: { code: "billing.internal_error" },
        });
        expect(await facts()).toEqual(before);
      },
    );
    it("returns a true empty page, and rejects a corrupt eligible name instead of inventing a default", async () => {
      const tenant = randomUUID();
      const empty = await get(tenant);
      expect(empty.statusCode).toBe(200);
      expect(empty.json()).toEqual({
        data: { items: [], page: { next_cursor: null } },
      });
      const parent = await offer(tenant, "corrupt");
      await revision(tenant, parent.id, 1, { name: "" });
      const before = await facts();
      expect((await get(tenant)).statusCode).toBe(500);
      expect(await facts()).toEqual(before);
    });
  },
);
