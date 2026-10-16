import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import {
  decodeCatalogCursor,
  encodeCatalogCursor,
  parseCatalogQuery,
} from "../../src/modules/commerce/catalog.query.js";
const cursor = {
  version: 1,
  scope: "commerce.catalog",
  tenantId: "tenant-a",
  offerKey: "产品😀",
  revision: 3,
  revisionId: "11111111-1111-4111-8111-111111111111",
} as const;
const request = (
  url: string,
  headers: Record<string, string> = {},
  body?: unknown,
) => ({ url, headers, body }) as FastifyRequest;
describe("Catalog bounded query and tenant-scoped cursor", () => {
  it("roundtrips an exact unicode tuple and default/bounded page sizes", () => {
    expect(
      decodeCatalogCursor(encodeCatalogCursor(cursor), "tenant-a"),
    ).toEqual(cursor);
    expect(
      parseCatalogQuery(request("/v2/commerce/catalog"), "tenant-a"),
    ).toEqual({ limit: 50 });
    expect(
      parseCatalogQuery(
        request(
          "/v2/commerce/catalog?limit=100&cursor=" +
            encodeCatalogCursor(cursor),
        ),
        "tenant-a",
      ),
    ).toEqual({ limit: 100, cursor });
  });
  it("keeps maximum Unicode tenant/key cursor within the wire budget", () => {
    const maximum = {
      ...cursor,
      tenantId: "😀".repeat(191),
      offerKey: "😀".repeat(255),
    };
    const wire = encodeCatalogCursor(maximum);
    expect(wire.length).toBeLessThanOrEqual(2048);
    expect(decodeCatalogCursor(wire, maximum.tenantId)).toEqual(maximum);
  });
  it.each([
    "limit=0",
    "limit=101",
    "limit=01",
    "limit=1.5",
    "limit=1&limit=2",
    "cursor=",
    "cursor=A",
    "cursor=a&cursor=b",
    "offset=1",
    "unknown=x",
  ])("rejects %s", (query) => {
    expect(() =>
      parseCatalogQuery(request("/v2/commerce/catalog?" + query), "tenant-a"),
    ).toThrow();
  });
  it.each(["content-length", "transfer-encoding"])(
    "rejects body transport %s, including zero length",
    (name) => {
      expect(() =>
        parseCatalogQuery(
          request("/v2/commerce/catalog", { [name]: "0" }),
          "tenant-a",
        ),
      ).toThrow();
    },
  );
  it("rejects body and cross-tenant/noncanonical/foreign-scope cursor before any database work", () => {
    expect(() =>
      parseCatalogQuery(request("/v2/commerce/catalog", {}, {}), "tenant-a"),
    ).toThrow();
    const wire = encodeCatalogCursor(cursor);
    for (const value of [
      wire + "=",
      "a".repeat(2049),
      Buffer.from([0xff]).toString("base64url"),
      Buffer.from(
        JSON.stringify({ ...cursor, scope: "credit.ledger" }),
      ).toString("base64url"),
      Buffer.from(JSON.stringify({ ...cursor, extra: true })).toString(
        "base64url",
      ),
    ])
      expect(() => decodeCatalogCursor(value, "tenant-a")).toThrow();
    expect(() => decodeCatalogCursor(wire, "tenant-b")).toThrow();
  });
});
