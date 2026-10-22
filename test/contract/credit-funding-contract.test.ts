import { meteringManagementBaselineSource } from "../../scripts/metering-management-contract.js";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { creditFundingBaselineSource } from "../../scripts/credit-funding-contract.js";
import { assertCreditAccountContract } from "../../scripts/credit-account-contract.js";
const source = async () =>
  meteringManagementBaselineSource(
    await readFile("contract/openapi/v1/openapi.yaml", "utf8"),
  );
describe("non-cash administrative grant current-only machine contract", () => {
  it("preserves every preceding operation and schema while publishing the closed funding capability", async () => {
    const raw = await source();
    const baseline = creditFundingBaselineSource(raw);
    expect(createHash("sha256").update(baseline).digest("hex")).toBe(
      "f934d6f81842fafaec2e3e64cca6bd4669f86601979bd737941a5695506814fe",
    );
    expect(() => assertCreditAccountContract(baseline)).not.toThrow();
    expect(() => creditFundingBaselineSource(baseline)).toThrow();
    const doc = parse(raw) as {
      info: { version: string };
      paths: Record<string, Record<string, unknown>>;
      components: { schemas: Record<string, unknown> };
    };
    expect(doc.info.version).toBe("4.0.0-experimental.4");
    expect(Object.keys(doc.components.schemas)).toHaveLength(45);
    expect(
      Object.values(doc.paths).reduce(
        (count, item) =>
          count +
          Object.keys(item).filter((k) =>
            ["get", "put", "post", "delete", "patch"].includes(k),
          ).length,
        0,
      ),
    ).toBe(26);
    const grant = doc.paths["/v1/admin/billing/credit-grants"]?.post as Record<
      string,
      unknown
    >;
    expect(grant.security).toEqual([
      {
        serviceCaller: [],
        internalSecret: [],
        serviceBearer: [],
        tenantContext: [],
        subjectContext: [],
        operatorProxySecret: [],
      },
    ]);
  });
  it.each([
    [
      "x-kokoro-permission: web-bff-billing-admin-proxy",
      "x-kokoro-permission: authenticated-user",
    ],
    [
      '          operatorProxySecret: []\n      parameters:\n        - $ref: "#/components/parameters/PersonalTenantId"',
      '      parameters:\n        - $ref: "#/components/parameters/PersonalTenantId"',
    ],
    [
      "    AdminCreditGrantRequest:\n      type: object\n      additionalProperties: false",
      "    AdminCreditGrantRequest:\n      type: object\n      additionalProperties: true",
    ],
    [
      "          pattern: ^[1-9][0-9]{0,12}$(?![\\s\\S])",
      "          pattern: ^[0-9.]+$",
    ],
    ["version: 4.0.0-experimental.4", "version: 4.0.0-experimental.3"],
  ])(
    "rejects weakening or retired version without a runtime fallback %#",
    async (from, to) => {
      const raw = await source();
      const mutated = raw.replace(from, to);
      expect(mutated).not.toBe(raw);
      expect(() => creditFundingBaselineSource(mutated)).toThrow();
    },
  );
});
