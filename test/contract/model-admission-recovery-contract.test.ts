import { createHash } from "node:crypto";
import { modelAdmissionRecoveryBaselineSource } from "../../scripts/model-admission-recovery-contract.js";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { expect, test } from "vitest";
test("recover is a dedicated proof-free committed-only operation reusing the original closed wire schema", async () => {
  const doc = parse(
    await readFile("contract/openapi/v1/openapi.yaml", "utf8"),
  ) as {
    paths: Record<
      string,
      {
        post: {
          operationId: string;
          parameters: Array<{ name?: string; $ref?: string }>;
          requestBody: {
            content: Record<string, { schema: { $ref: string } }>;
          };
          responses: Record<string, unknown>;
          security: unknown;
        };
      }
    >;
  };
  const op = doc.paths["/v1/internal/billing/admissions/recover"]?.post;
  expect(op?.operationId).toBe("recoverModelAdmission");
  expect(op?.requestBody.content["application/json"]?.schema.$ref).toBe(
    "#/components/schemas/AdmissionCreateRequest",
  );
  expect(op?.parameters.map((x) => x.name)).not.toContain(
    "x-billing-execution-proof",
  );
  expect(op?.responses["200"]).toBeDefined();
  expect(op?.responses["404"]).toBeDefined();
  expect(op?.responses["201"]).toBeUndefined();
});

test("recover-only inverse preserves the entire original exp9 and rejects missing, duplicate or unrelated mutations", async () => {
  const source = await readFile("contract/openapi/v1/openapi.yaml", "utf8");
  expect(
    createHash("sha256")
      .update(modelAdmissionRecoveryBaselineSource(source))
      .digest("hex"),
  ).toBe("7b5335fde2be601b2d6256cb9b68b0964d5518cfa053b50f2029358a059a0924");
  for (const altered of [
    source.replace("/admissions/recover:", "/admissions/not-recover:"),
    source.replace(
      "  /v1/internal/billing/admissions/recover:",
      "  /v1/internal/billing/admissions/recover:\n  /v1/internal/billing/admissions/recover:",
    ),
    source.replace("operationId: getCatalog", "operationId: changedCatalog"),
  ])
    expect(() => modelAdmissionRecoveryBaselineSource(altered)).toThrow();
});
