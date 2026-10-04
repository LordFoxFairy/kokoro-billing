import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";
import { Ajv2020 } from "ajv/dist/2020.js";
import formatsModule from "ajv-formats";

const recordSchema = z.record(z.string(), z.unknown());
const openApiSchema = z
  .object({
    paths: z.record(z.string(), recordSchema),
    components: z.object({
      parameters: recordSchema,
      securitySchemes: recordSchema,
      requestBodies: recordSchema,
      schemas: recordSchema,
    }),
  })
  .passthrough();

const readV1Contract = async () =>
  openApiSchema.parse(
    parse(
      await readFile(
        join(process.cwd(), "contract/openapi/v1/openapi.yaml"),
        "utf8",
      ),
    ),
  );

const operation = (
  document: z.infer<typeof openApiSchema>,
  path: string,
): Record<string, unknown> => {
  const pathItem = document.paths[path];
  return recordSchema.parse(pathItem?.post);
};

describe("Billing command OpenAPI contract", () => {
  it("keeps admission command bodies and execution conflict status aligned with runtime", async () => {
    const document = await readV1Contract();
    expect(
      operation(
        document,
        "/v1/internal/entitlement/admissions/{admissionId}/capture",
      ).requestBody,
    ).toEqual({
      $ref: "#/components/requestBodies/V1AdmissionCaptureRequest",
    });
    expect(
      operation(
        document,
        "/v1/internal/entitlement/admissions/{admissionId}/release",
      ).requestBody,
    ).toEqual({
      $ref: "#/components/requestBodies/V1AdmissionReleaseRequest",
    });
    expect(
      recordSchema.parse(
        operation(document, "/v1/internal/billing/execution-events").responses,
      ),
    ).toHaveProperty("409");

    const capture = recordSchema.parse(
      document.components.schemas.V1AdmissionCaptureRequest,
    );
    expect(capture.required).toEqual([
      "invocation_id",
      "execution_id",
      "accepted_provider_ref",
      "accepted_at",
      "service_receipt",
      "receipt_schema_version",
    ]);
    expect(capture.additionalProperties).toBe(false);

    const release = recordSchema.parse(
      document.components.schemas.V1AdmissionReleaseRequest,
    );
    expect(release.required).toEqual(["invocation_id", "reason"]);
    expect(release.additionalProperties).toBe(false);

    const idempotencyKey = recordSchema.parse(
      document.components.parameters.IdempotencyKey,
    );
    const idempotencyKeySchema = recordSchema.parse(idempotencyKey.schema);
    expect(idempotencyKeySchema).toMatchObject({
      minLength: 8,
      maxLength: 128,
      pattern: "^[\\x20-\\x7E]+$",
    });

    const ready = recordSchema.parse(document.components.schemas.ReadyResponse);
    const readyData = recordSchema.parse(
      recordSchema.parse(ready.properties).data,
    );
    const dependencies = recordSchema.parse(
      recordSchema.parse(readyData.properties).dependencies,
    );
    const redis = recordSchema.parse(
      recordSchema.parse(dependencies.properties).redis,
    );
    expect(redis.enum).toEqual(["ok", "degraded"]);
  });

  it("defines exact request bodies for durable settlement and expiry commands", async () => {
    const document = await readV1Contract();
    expect(
      operation(document, "/v1/internal/payment/settlements/accept")
        .requestBody,
    ).toEqual({
      $ref: "#/components/requestBodies/V1SettlementAcceptRequest",
    });
    expect(
      operation(document, "/v1/internal/commands/expire-credit-holds")
        .requestBody,
    ).toEqual({
      $ref: "#/components/requestBodies/V1ExpireCreditHoldsRequest",
    });

    const settlement = recordSchema.parse(
      document.components.schemas.V1SettlementAcceptRequest,
    );
    expect(settlement.required).toEqual([
      "settlement_id",
      "provider",
      "external_payment_ref",
      "amount_minor",
      "currency",
    ]);
    expect(settlement.additionalProperties).toBe(false);
    const settlementProperties = recordSchema.parse(settlement.properties);
    expect(recordSchema.parse(settlementProperties.provider).enum).toEqual([
      "stripe",
      "alipay",
      "wechat",
    ]);

    const expiry = recordSchema.parse(
      document.components.schemas.V1ExpireCreditHoldsRequest,
    );
    expect(expiry.required).toEqual(["batch_id"]);
    expect(expiry.additionalProperties).toBe(false);
  });

  it("documents only production webhook providers and the Alipay form-body signature", async () => {
    const document = await readV1Contract();
    const webhook = operation(document, "/v1/webhooks/payment/{provider}");
    const parameters = z.array(recordSchema).parse(webhook.parameters);
    const provider = parameters.find(
      (parameter) => parameter.name === "provider",
    );
    expect(provider).toBeDefined();
    expect(recordSchema.parse(provider?.schema).enum).toEqual([
      "stripe",
      "alipay",
      "wechat",
    ]);

    expect(document.components.securitySchemes).not.toHaveProperty(
      "mockSignature",
    );
    expect(document.components.securitySchemes).not.toHaveProperty(
      "alipayBodySignature",
    );
    expect(webhook["x-kokoro-provider-signatures"]).toEqual({
      stripe: { location: "header", fields: ["Stripe-Signature"] },
      alipay: { location: "form-body", fields: ["sign", "sign_type"] },
      wechat: {
        location: "header",
        fields: [
          "Wechatpay-Timestamp",
          "Wechatpay-Nonce",
          "Wechatpay-Signature",
        ],
      },
    });

    const requestBody = recordSchema.parse(webhook.requestBody);
    const content = recordSchema.parse(requestBody.content);
    const form = recordSchema.parse(
      content["application/x-www-form-urlencoded"],
    );
    expect(form.schema).toEqual({
      $ref: "#/components/schemas/AlipayWebhookForm",
    });
    const alipay = recordSchema.parse(
      document.components.schemas.AlipayWebhookForm,
    );
    expect(alipay.required).toEqual(["notify_id", "sign", "sign_type"]);
    expect(
      recordSchema.parse(recordSchema.parse(alipay.properties).sign_type).enum,
    ).toEqual(["RSA2"]);
  });
});

describe("Billing v2 per-attempt command contract", () => {
  it("removes generic receipts and freezes strict Agent evidence identity", async () => {
    const document = recordSchema.parse(
      parse(
        await readFile(
          join(process.cwd(), "contract/openapi/v2/openapi.yaml"),
          "utf8",
        ),
      ),
    );
    const components = recordSchema.parse(document.components);
    const schemas = recordSchema.parse(components.schemas);
    const create = recordSchema.parse(schemas.AdmissionCreateRequest);
    const capture = recordSchema.parse(schemas.AdmissionCaptureRequest);
    const release = recordSchema.parse(schemas.AdmissionReleaseRequest);
    const event = recordSchema.parse(schemas.ExecutionEventRequest);
    const admission = recordSchema.parse(schemas.Admission);
    const durableEvent = recordSchema.parse(schemas.ExecutionEvent);
    const createProperties = recordSchema.parse(create.properties);
    expect(create.required).toContain("billing_subject");
    expect(createProperties).not.toHaveProperty("payer_ref");
    expect(recordSchema.parse(createProperties.billing_subject)).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["kind", "ref"],
      properties: {
        kind: {
          type: "string",
          enum: ["user", "project", "organization", "service"],
        },
        ref: { type: "string", minLength: 1, maxLength: 255 },
      },
    });
    expect(capture.additionalProperties).toBe(false);
    expect(recordSchema.parse(capture.properties)).not.toHaveProperty(
      "service_receipt",
    );
    expect(recordSchema.parse(release.properties)).not.toHaveProperty(
      "service_receipt",
    );
    expect(recordSchema.parse(event.properties)).not.toHaveProperty("receipt");
    expect(
      recordSchema.parse(
        recordSchema.parse(event.properties).evidence_schema_version,
      ).const,
    ).toBe("1.0.0");
    expect(recordSchema.parse(admission.properties)).toMatchObject({
      usage_profile_version: { const: "1.0.0" },
      usage_profile_digest: {
        const:
          "eb3e226f2c5ede407b61558c0375a373a8a7985f333b3d62a6c2b148469043d0",
      },
      authorization_status: {
        enum: ["authorized", "denied", "expired", "unknown"],
      },
      dispatch_status: {
        enum: ["awaiting", "not_dispatched", "started", "unknown"],
      },
    });
    expect(recordSchema.parse(durableEvent.properties)).toMatchObject({
      evidence_schema_version: { const: "1.0.0" },
      evidence_ref: { type: "string" },
      evidence_event_id: { type: "string", format: "uuid" },
      evidence_revision: { $ref: "#/components/schemas/PositiveDecimal" },
      evidence_digest: { type: "string", pattern: "^[0-9a-f]{64}$" },
    });
  });

  it.each(["denied", "expired", "unknown"] as const)(
    "rejects dispatch started when the durable authorization decision is %s",
    async (authorizationStatus) => {
      const document = recordSchema.parse(
        parse(
          await readFile(
            join(process.cwd(), "contract/openapi/v2/openapi.yaml"),
            "utf8",
          ),
        ),
      );
      const components = recordSchema.parse(document.components);
      const schemas = recordSchema.parse(components.schemas);
      const ajv = new Ajv2020({ strict: true });
      formatsModule.default(ajv);
      ajv.addKeyword({
        keyword: "x-kokoro-credit-unit",
        schemaType: "object",
        valid: true,
      });
      for (const [name, schema] of Object.entries(schemas))
        ajv.addSchema(
          recordSchema.parse(schema),
          `#/components/schemas/${name}`,
        );
      const validate = ajv.getSchema("#/components/schemas/Admission");
      expect(validate).toBeDefined();
      const admission = {
        admission_id: "11111111-1111-4111-8111-111111111111",
        producer: "kokoro-agent",
        run_id: "run-1",
        request_ref: "request-1",
        call_id: "22222222-2222-4222-8222-222222222222",
        attempt_id: "33333333-3333-4333-8333-333333333333",
        attempt_ordinal: "1",
        feature_key: "model.call",
        authorization_status: authorizationStatus,
        dispatch_status: "started",
        evidence_status: "awaiting",
        charge_status: "pending_evidence",
        authorized_micros: "1000",
        snapshot_id: "44444444-4444-4444-8444-444444444444",
        snapshot_digest: "1".repeat(64),
        rate_revision_id: "55555555-5555-4555-8555-555555555555",
        policy_revision_id: "66666666-6666-4666-8666-666666666666",
        normalization_version: "1.0.0",
        normalization_digest: "2".repeat(64),
        rounding_version: "1.0.0",
        currency_code: "CRD",
        valid_until: "2026-10-04T12:00:00.000Z",
        planned_binding_ref: "planned/1",
        planned_binding_digest: "3".repeat(64),
        usage_profile_version: "1.0.0",
        usage_profile_digest:
          "eb3e226f2c5ede407b61558c0375a373a8a7985f333b3d62a6c2b148469043d0",
        execution_bound_ref: "execution-bound/1",
        execution_bound_digest: "4".repeat(64),
        hold_id: "77777777-7777-4777-8777-777777777777",
        created_at: "2026-10-04T11:00:00.000Z",
        updated_at: "2026-10-04T11:00:00.000Z",
      };
      expect(validate?.(admission), JSON.stringify(validate?.errors)).toBe(
        false,
      );
      expect(
        validate?.({
          ...admission,
          authorization_status: "authorized",
        }),
        JSON.stringify(validate?.errors),
      ).toBe(true);
      expect(
        validate?.({ ...admission, dispatch_status: "unknown" }),
        JSON.stringify(validate?.errors),
      ).toBe(true);
    },
  );
});
