import { modelSettlementBaselineSource } from "../../scripts/model-settlement-contract.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { parse } from "yaml";
import { Ajv2020 } from "ajv/dist/2020.js";
import formats from "ajv-formats";
const source = readFileSync("contract/openapi/v1/openapi.yaml", "utf8");
const doc = parse(source) as {
  info: { version: string };
  paths: Record<string, Record<string, Record<string, unknown>>>;
  components: { schemas: Record<string, object> };
};
const ajv = new Ajv2020({ strict: true });
formats.default(ajv);
ajv.addKeyword({
  keyword: "x-kokoro-credit-unit",
  schemaType: "object",
  valid: true,
});
for (const [key, value] of Object.entries(doc.components.schemas))
  ajv.addSchema(value, `#/components/schemas/${key}`);
const accepts = (key: string, v: unknown) =>
  ajv.getSchema(`#/components/schemas/${key}`)?.(v) === true;
const request = {
  run_id: "run-qa",
  evidence_event_id: "11111111-1111-4111-8111-111111111111",
  evidence_revision: "1",
  evidence_digest: "a".repeat(64),
};
const response = {
  data: {
    admission_id: "22222222-2222-4222-8222-222222222222",
    attempt_id: "33333333-3333-4333-8333-333333333333",
    ...request,
    status: "captured",
    reason: null,
    captured_credits: "1",
    released_credits: "9",
    usage_event_id: "44444444-4444-4444-8444-444444444444",
    settlement_id: "55555555-5555-4555-8555-555555555555",
    updated_at: "2026-10-22T00:00:00.000Z",
  },
};
describe("owner-decided model settlement wire", () => {
  test("whole source inverse protects every original operation and exact retired fragments", () => {
    expect(
      createHash("sha256")
        .update(modelSettlementBaselineSource(source))
        .digest("hex"),
    ).toBe("2c65b64c896a85cb89e6b8f23ee9802b6e5cf2440d9a8debaa23973f5c199b6e");
    for (const [a, b] of [
      ["operationId: settleModelAdmission", "operationId: forged"],
      ["web-bff-model-admission", "agent-model-studio-service"],
      ["evidence_event_id, evidence_revision", "evidence_event_id, digest"],
      ["    AdmissionSettlementRequest:", "    ExtraSettlementRequest:"],
      ["operationId: getCatalog", "operationId: forgedCatalog"],
    ] as const) {
      const mutated = source.replace(a, b);
      expect(mutated).not.toBe(source);
      expect(() => modelSettlementBaselineSource(mutated)).toThrow();
    }
    expect(() => modelSettlementBaselineSource(source + source)).toThrow();
  });
  test("revision and whole credits remain exact at their decimal bounds", () => {
    const limit = 9223372036854775807n;
    for (const n of [
      1n,
      9n,
      10n,
      limit - 1n,
      limit,
      limit + 1n,
      9999999999999999999n,
    ])
      expect(
        accepts("AdmissionSettlementRequest", {
          ...request,
          evidence_revision: n.toString(),
        }),
      ).toBe(n <= limit);
    for (const n of [
      0n,
      1n,
      9223372036853n,
      9223372036854n,
      9223372036855n,
      9999999999999n,
    ])
      expect(
        accepts("AdmissionSettlementResponse", {
          data: { ...response.data, captured_credits: n.toString() },
        }),
      ).toBe(n <= 9223372036854n);
  });

  test("publishes one BFF-only settlement, retiring both caller-decided commands", () => {
    expect(doc.info.version).toBe("4.0.0-experimental.9");
    const op =
      doc.paths["/v1/internal/billing/admissions/{admission_id}/settle"]?.post;
    expect(op?.operationId).toBe("settleModelAdmission");
    expect(op?.security).toEqual([
      {
        serviceCaller: [],
        internalSecret: [],
        serviceBearer: [],
        tenantContext: [],
        subjectContext: [],
      },
    ]);
    expect(op?.["x-kokoro-permission"]).toBe("web-bff-model-admission");
    expect(op?.parameters).toContainEqual({
      $ref: "#/components/parameters/IdempotencyKey",
    });
    for (const name of ["capture", "release"])
      expect(
        doc.paths[`/v1/internal/billing/admissions/{admission_id}/${name}`],
      ).toBeUndefined();
    for (const name of ["AdmissionCaptureRequest", "AdmissionReleaseRequest"])
      expect(doc.components.schemas[name]).toBeUndefined();
  });
  test("accepts only sealed evidence metadata and a bound Run", () => {
    expect(accepts("AdmissionSettlementRequest", request)).toBe(true);
    for (const field of Object.keys(request)) {
      const v = { ...request };
      delete v[field as keyof typeof v];
      expect(accepts("AdmissionSettlementRequest", v)).toBe(false);
    }
    for (const extra of [
      "tenant_id",
      "actor_id",
      "actual_micros",
      "status",
      "evidence_json",
      "release_basis",
      "execution_proof",
    ])
      expect(
        accepts("AdmissionSettlementRequest", {
          ...request,
          [extra]: "caller-value",
        }),
      ).toBe(false);
  });
  test.each(["0", "01", "9223372036854775808", "1\n"])(
    "rejects invalid revision %s",
    (revision) =>
      expect(
        accepts("AdmissionSettlementRequest", {
          ...request,
          evidence_revision: revision,
        }),
      ).toBe(false),
  );
  test("ACK distinguishes capture/release/pending and hides raw evidence", () => {
    expect(accepts("AdmissionSettlementResponse", response)).toBe(true);
    const released = {
      data: {
        ...response.data,
        status: "released",
        captured_credits: "0",
        released_credits: "10",
        usage_event_id: null,
        settlement_id: null,
      },
    };
    expect(accepts("AdmissionSettlementResponse", released)).toBe(true);
    for (const reason of ["budget_exceeded", "unknown_usage_or_outcome"]) {
      expect(
        accepts("AdmissionSettlementResponse", {
          data: {
            ...released.data,
            status: "pending_reconciliation",
            reason,
            released_credits: "0",
          },
        }),
      ).toBe(true);
    }
    for (const patch of [
      { captured_credits: "1.1" },
      { captured_credits: "01" },
      { captured_credits: "9223372036855" },
      { status: "pending_reconciliation" },
      { reason: "budget_exceeded" },
      { usage_event_id: null },
      { evidence_json: "private" },
    ])
      expect(
        accepts("AdmissionSettlementResponse", {
          data: { ...response.data, ...patch },
        }),
      ).toBe(false);
  });
});
