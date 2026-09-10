import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

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

const readContract = async () =>
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
    const document = await readContract();
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
    const document = await readContract();
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
    const document = await readContract();
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
