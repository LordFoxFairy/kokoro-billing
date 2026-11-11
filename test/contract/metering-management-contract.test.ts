import { meteringModelBindingBaselineSource } from "../../scripts/metering-model-binding-contract.js";
import { createHash } from "node:crypto";
import { meteringManagementBaselineSource } from "../../scripts/metering-management-contract.js";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { parse } from "yaml";

const source = readFileSync("contract/openapi/v1/openapi.yaml", "utf8");
const document = parse(source) as {
  info: { version: string };
  paths: Record<
    string,
    Record<string, { operationId: string; security: unknown }>
  >;
  components: { schemas: Record<string, unknown> };
};
describe("formal metering management wire contract", () => {
  test("publishes the current three operations without replacing earlier contracts", () => {
    expect(document.info.version).toBe("4.0.0-experimental.10");
    for (const [method, path, id] of [
      ["get", "/v1/admin/billing/metering/pricing", "getAdminMeteringPricing"],
      [
        "post",
        "/v1/admin/billing/metering/rate-revisions",
        "publishAdminMeteringRate",
      ],
      [
        "post",
        "/v1/admin/billing/metering/policy-revisions",
        "publishAdminMeteringPolicy",
      ],
    ] as const) {
      expect(document.paths[path]?.[method]?.operationId).toBe(id);
      expect(document.paths[path]?.[method]?.security).toEqual(
        document.paths["/v1/admin/billing/credit-grants"]?.post?.security,
      );
    }
  });
  test("has closed tenant-free publication commands and exact integer budget strings", () => {
    expect(
      document.components.schemas.AdminMeteringRatePublishRequest,
    ).toMatchObject({
      additionalProperties: false,
      required: ["publication_id", "reason", "configuration"],
    });
    expect(
      document.components.schemas.MeteringPolicyConfiguration,
    ).toMatchObject({
      additionalProperties: false,
      properties: { max_attempt_credits: { type: "string" } },
    });
  });
  test("exactly restores the prior 26 operations and 45 schemas, not a runtime fallback", () => {
    const previous = meteringManagementBaselineSource(source);
    expect(createHash("sha256").update(previous).digest("hex")).toBe(
      "a09e00a3d6f602fdaff13a50a5a839c8a989b1a26ab28c43eac314738fcfdef2",
    );
    expect(() => meteringManagementBaselineSource(previous)).toThrow();
  });
  test.each([
    ["web-bff-billing-admin-proxy", "authenticated-user"],
    ["MeteringRational:", "MeteringRationalWeakened:"],
    ["max_attempt_credits:", "default_budget:"],
    ["version: 4.0.0-experimental.10", "version: 4.0.0-experimental.4"],
  ])(
    "rejects changed management semantics and preceding contract bytes %#",
    (from, to) => {
      const mutated = source.replace(from, to);
      expect(mutated).not.toBe(source);
      expect(() => meteringManagementBaselineSource(mutated)).toThrow();
    },
  );
});

test("exact model binding restores the complete prior publication byte-for-byte", () => {
  const baseline = meteringModelBindingBaselineSource(source);
  expect(createHash("sha256").update(baseline).digest("hex")).toBe(
    "8005cff204976ca681653565fb8b6b098bc195cc70049743f70ae85989df35ab",
  );
  expect(() => meteringModelBindingBaselineSource(baseline)).toThrow();
  for (const [from, to] of [
    ["        - model_revision\n", ""],
    ["            - content_digest\n", ""],
    ["model_revision:", "guessed_model_name:"],
  ] as const) {
    const changed = source.replace(from, to);
    expect(changed).not.toBe(source);
    expect(() => meteringModelBindingBaselineSource(changed)).toThrow();
  }
});
