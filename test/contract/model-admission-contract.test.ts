import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { parse } from "yaml";
import { Ajv2020 } from "ajv/dist/2020.js";
import formats from "ajv-formats";
const source = readFileSync("contract/openapi/v1/openapi.yaml", "utf8");
const document = parse(source) as {
  info: { version: string };
  components: { schemas: Record<string, object> };
  paths: Record<string, Record<string, Record<string, unknown>>>;
};
const ajv = new Ajv2020({ strict: true });
formats.default(ajv);
ajv.addKeyword({
  keyword: "x-kokoro-credit-unit",
  schemaType: "object",
  valid: true,
});
for (const [name, schema] of Object.entries(document.components.schemas))
  ajv.addSchema(schema, `#/components/schemas/${name}`);
const accepts = (name: string, value: unknown) =>
  ajv.getSchema(`#/components/schemas/${name}`)?.(value) === true;
const create = {
  run_id: "run-a",
  attempt_id: "abcdef01-abcd-4abc-8abc-abcdefabcdef",
  request_ref: "request-a",
  attempt_binding_digest: "a".repeat(64),
  planned_digest: "b".repeat(64),
  final_request_digest: "c".repeat(64),
};
const admission = {
  admission_id: "22222222-2222-4222-8222-222222222222",
  ...create,
  hold_id: "33333333-3333-4333-8333-333333333333",
  budget_credits: "10",
  pricing_snapshot_digest: "d".repeat(64),
  status: "held",
  created_at: "2026-10-22T00:00:00.000Z",
  updated_at: "2026-10-22T00:00:00.000Z",
};
describe("current whole-budget model admission HTTP contract", () => {
  test("publishes the original two operation IDs with complete BFF-only u1 context", () => {
    expect(document.info.version).toBe("4.0.0-experimental.7");
    for (const [path, method, id] of [
      ["/v1/internal/billing/admissions", "post", "createAdmission"],
      ["/v1/internal/billing/admissions/{admission_id}", "get", "getAdmission"],
    ] as const) {
      const op = document.paths[path]?.[method];
      expect(op?.operationId).toBe(id);
      expect(op?.security).toEqual([
        {
          serviceCaller: [],
          internalSecret: [],
          serviceBearer: [],
          tenantContext: [],
          subjectContext: [],
        },
      ]);
      expect(op?.parameters).toContainEqual({
        $ref: "#/components/parameters/PersonalTenantId",
      });
    }
  });
  test("accepts only bound preparation facts, not caller payer, price or old guarantees", () => {
    expect(accepts("AdmissionCreateRequest", create)).toBe(true);
    for (const field of Object.keys(create)) {
      const copy = { ...create } as Record<string, unknown>;
      delete copy[field];
      expect(accepts("AdmissionCreateRequest", copy)).toBe(false);
    }
    for (const key of [
      "billing_subject",
      "tenant_id",
      "actor_id",
      "budget_credits",
      "execution_bound_ref",
      "execution_bound_digest",
      "planned_binding_ref",
      "usage_profile_version",
      "usage_profile_digest",
    ]) {
      expect(
        accepts("AdmissionCreateRequest", {
          ...create,
          [key]: "caller-invented",
        }),
      ).toBe(false);
    }
  });
  test("returns only true frozen budget facts and four current financial states", () => {
    for (const status of [
      "held",
      "captured",
      "released",
      "pending_reconciliation",
    ])
      expect(
        accepts("AdmissionResponse", { data: { ...admission, status } }),
      ).toBe(true);
    for (const extra of [
      "producer",
      "authorized_micros",
      "authorization_status",
      "dispatch_status",
      "evidence_status",
      "charge_status",
      "execution_bound_ref",
      "snapshot_id",
      "valid_until",
      "payer_ref",
      "consumption_token",
    ])
      expect(
        accepts("AdmissionResponse", {
          data: { ...admission, [extra]: "not-a-fact" },
        }),
      ).toBe(false);
    for (const budget_credits of [
      0,
      10,
      "0",
      "-1",
      "1.2",
      "01",
      "9223372036855",
      "9999999999999",
    ])
      expect(
        accepts("AdmissionResponse", {
          data: { ...admission, budget_credits },
        }),
      ).toBe(false);
  });
  test("rejects noncanonical UUIDs and digests before owner network I/O", () => {
    for (const attempt_id of [
      create.attempt_id.toUpperCase(),
      "bad",
      create.attempt_id + "\n",
    ]) {
      if (attempt_id !== create.attempt_id)
        expect(
          accepts("AdmissionCreateRequest", { ...create, attempt_id }),
        ).toBe(false);
    }
    for (const final_request_digest of [
      "F".repeat(64),
      "0",
      create.final_request_digest + "\n",
    ])
      expect(
        accepts("AdmissionCreateRequest", { ...create, final_request_digest }),
      ).toBe(false);
  });
  test("describes exact millisecond UTC timestamps and canonical budget ceiling", () => {
    expect(
      accepts("AdmissionResponse", {
        data: { ...admission, budget_credits: "9223372036854" },
      }),
    ).toBe(true);
    for (const created_at of [
      "2026-10-22T00:00:00Z",
      "2026-10-22T00:00:00.0000Z",
      admission.created_at + "\n",
    ])
      expect(
        accepts("AdmissionResponse", { data: { ...admission, created_at } }),
      ).toBe(false);
  });
});
