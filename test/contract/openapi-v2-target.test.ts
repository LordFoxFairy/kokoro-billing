import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  assertV2OpenApi,
  validateV2OpenApi,
} from "../../scripts/openapi-v2-target.js";

type JsonObject = Record<string, unknown>;
const target = join(process.cwd(), "contract/openapi/v2/openapi.yaml");
const record = (value: unknown): JsonObject => {
  expect(value).not.toBeNull();
  expect(typeof value).toBe("object");
  expect(Array.isArray(value)).toBe(false);
  return value as JsonObject;
};
const readContract = async (): Promise<JsonObject> =>
  record(parse(await readFile(target, "utf8")) as unknown);
const clone = (value: JsonObject): JsonObject => structuredClone(value);
const schemaProperties = (document: JsonObject, name: string): JsonObject =>
  record(record(record(document.components).schemas)[name])
    .properties as JsonObject;

const mutate = (
  document: JsonObject,
  callback: (copy: JsonObject) => void,
): string[] => {
  const copy = clone(document);
  callback(copy);
  return validateV2OpenApi(copy);
};

describe("Billing v2 target OpenAPI", () => {
  it("publishes the complete target major contract with fully resolved refs", async () => {
    const document = await readContract();
    expect(() => assertV2OpenApi(document)).not.toThrow();
    expect(record(document.info).version).toBe("2.0.1");
    const operationCount = Object.values(record(document.paths)).reduce<number>(
      (count, path) =>
        count +
        Object.keys(record(path)).filter((method) =>
          ["get", "post", "put", "patch", "delete"].includes(method),
        ).length,
      0,
    );
    expect(operationCount).toBe(24);
  });

  it("uses owner-generated UUID resources while external identities remain opaque", async () => {
    const document = await readContract();
    for (const [schema, id] of [
      ["Admission", "admission_id"],
      ["ExecutionEvent", "execution_event_id"],
      ["Checkout", "checkout_id"],
      ["Settlement", "settlement_id"],
      ["Refund", "refund_id"],
    ] as const) {
      expect(record(schemaProperties(document, schema)[id]).$ref).toBe(
        "#/components/schemas/Uuid",
      );
    }
    expect(
      record(schemaProperties(document, "ExecutionEvent").event_id),
    ).toMatchObject({
      type: "string",
      maxLength: 255,
    });
    expect(
      record(schemaProperties(document, "ExpireCreditHoldsRequest").batch_id),
    ).toMatchObject({
      type: "string",
      maxLength: 128,
    });
  });

  it("does not accept caller authority, payer, quote, or local settlement identity", async () => {
    const document = await readContract();
    const admission = schemaProperties(document, "AdmissionCreateRequest");
    expect(admission).toHaveProperty("billing_subject");
    expect(admission).not.toHaveProperty("payer_ref");
    expect(record(admission.feature_key).maxLength).toBe(128);
    expect(record(admission.meter_kind).enum).toEqual([
      "model_invocation",
      "feature",
      "studio_job",
    ]);
    const checkout = schemaProperties(document, "CheckoutCreateRequest");
    expect(Object.keys(checkout)).toEqual(["offer_revision_id"]);
    const settlement = schemaProperties(document, "SettlementCreateRequest");
    expect(settlement).not.toHaveProperty("settlement_id");
    expect(Object.keys(settlement)).toEqual(
      expect.arrayContaining([
        "provider",
        "provider_account_id",
        "external_payment_ref",
        "amount_minor",
        "currency_code",
      ]),
    );
    expect(record(settlement.amount_minor).$ref).toBe(
      "#/components/schemas/PositiveDecimal",
    );
    expect(
      record(schemaProperties(document, "ExpireCreditHoldsRequest").limit)
        .maximum,
    ).toBe(500);
  });

  it("distinguishes resource creation, asynchronous execution acceptance, and provider ACKs", async () => {
    const document = await readContract();
    const paths = record(document.paths);
    const operation = (path: string, method = "post") =>
      record(record(paths[path])[method]);
    const response = (path: string, status: string) =>
      record(record(operation(path).responses)[status]);

    expect(
      record(response("/v2/internal/billing/execution-events", "202").headers),
    ).toHaveProperty("Location");
    for (const path of [
      "/v2/internal/billing/admissions",
      "/v2/billing/checkouts",
      "/v2/internal/payment/settlements",
      "/v2/internal/payment/refunds",
      "/v2/admin/billing/refunds",
    ]) {
      expect(record(response(path, "201").headers)).toHaveProperty("Location");
    }
    expect(response("/v2/webhooks/payment/stripe", "200")).not.toHaveProperty(
      "content",
    );
    expect(response("/v2/webhooks/payment/wechat", "204")).not.toHaveProperty(
      "content",
    );
    expect(
      record(
        record(
          record(
            record(response("/v2/webhooks/payment/alipay", "200").content)[
              "text/plain"
            ],
          ).schema,
        ),
      ).const,
    ).toBe("success");
  });

  it("detects semantic mutations rather than only counting routes", async () => {
    const document = await readContract();
    expect(
      mutate(document, (copy) => {
        record(
          record(record(copy.paths)["/v2/billing/checkouts"]).post,
        ).operationId = "getCheckout";
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining("duplicate operationId"),
      ]),
    );
    expect(
      mutate(document, (copy) => {
        record(
          record(
            record(
              record(record(copy.components).schemas).CheckoutCreateRequest,
            ).properties,
          ),
        ).amount_minor = { type: "string" };
      }),
    ).toContain("CheckoutCreateRequest must not accept amount_minor");
    expect(
      mutate(document, (copy) => {
        record(
          record(
            record(record(copy.components).schemas).SettlementCreateRequest,
          ).properties,
        ).settlement_id = { $ref: "#/components/schemas/Uuid" };
      }),
    ).toContain("SettlementCreateRequest must not accept settlement_id");
    expect(
      mutate(document, (copy) => {
        record(
          record(record(copy.components).schemas).AdmissionCreateRequest,
        ).properties = {
          ...schemaProperties(copy, "AdmissionCreateRequest"),
          payer_ref: { type: "string" },
        };
      }),
    ).toContain("AdmissionCreateRequest must not accept payer_ref");
    expect(
      mutate(document, (copy) => {
        record(record(record(copy.components).schemas).Checkout).properties = {
          ...schemaProperties(copy, "Checkout"),
          broken: { $ref: "#/components/schemas/Missing" },
        };
      }),
    ).toEqual(expect.arrayContaining([expect.stringContaining("unknown ref")]));
    expect(
      mutate(document, (copy) => {
        record(
          record(record(record(copy.paths)["/v2/billing/checkouts"]).post)
            .responses,
        )["400"] = {
          description: "bad",
          headers: { "x-request-id": { type: "string" } },
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        };
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining("missing explicit error semantics"),
      ]),
    );
    expect(
      mutate(document, (copy) => {
        record(record(copy.components).schemas).BadEnvelope = {
          type: "object",
          properties: { request_id: { type: "string" } },
        };
      }),
    ).toEqual(
      expect.arrayContaining([expect.stringContaining("embeds request id")]),
    );
  });

  it("rejects removed authentication factors, representations, ACKs, and nullable fields", async () => {
    const document = await readContract();
    const paths = (copy: JsonObject) => record(copy.paths);
    const post = (copy: JsonObject, path: string) =>
      record(record(paths(copy)[path]).post);
    const rejected = (callback: (copy: JsonObject) => void, message: string) =>
      expect(mutate(document, callback)).toEqual(
        expect.arrayContaining([expect.stringContaining(message)]),
      );

    rejected((copy) => {
      post(copy, "/v2/internal/billing/admissions").security = [];
    }, "requires authenticated service security");
    rejected((copy) => {
      const admission = post(copy, "/v2/internal/billing/admissions");
      admission.parameters = (admission.parameters as unknown[]).filter(
        (parameter) =>
          record(parameter).$ref !== "#/components/parameters/ConsumptionToken",
      );
    }, "requires ConsumptionToken");
    rejected((copy) => {
      const checkout = post(copy, "/v2/billing/checkouts");
      delete record(record(checkout.responses)["201"]).content;
    }, "missing success representation");
    rejected((copy) => {
      delete record(post(copy, "/v2/webhooks/payment/stripe").responses)["200"];
    }, "must define a 200 ACK");
    rejected((copy) => {
      const operation = record(
        record(paths(copy)["/v2/billing/checkouts/{checkout_id}"]).get,
      );
      const parameter = (operation.parameters as unknown[])
        .map(record)
        .find((item) => item.in === "path");
      record(parameter).schema = { type: "string" };
    }, "must be UUID");
    rejected((copy) => {
      post(copy, "/v2/internal/payment/settlements")["x-kokoro-permission"] =
        "none";
    }, "invalid permission");
    rejected((copy) => {
      record(record(post(copy, "/v2/billing/checkouts").responses)["403"])[
        "x-kokoro-errors"
      ] = [];
    }, "missing explicit error semantics");
    rejected((copy) => {
      record(
        record(record(copy.components).schemas).AdmissionCreateRequest,
      ).additionalProperties = true;
    }, "must reject unknown fields");
    rejected((copy) => {
      const admission = record(
        record(record(copy.components).schemas).Admission,
      );
      admission.required = (admission.required as unknown[]).filter(
        (field) => field !== "hold_id",
      );
    }, "Admission.hold_id must be required and nullable");
    rejected((copy) => {
      const checkout = post(copy, "/v2/billing/checkouts");
      checkout.security = (checkout.security as unknown[]).filter(
        (alternative) => !Object.hasOwn(record(alternative), "subjectContext"),
      );
    }, "incomplete authentication factors");
  });
});

const creditUnitExtension = "x-kokoro-credit-unit";
const approvedCreditUnit = {
  definition_version: 1,
  display_unit: "credit",
  micros_per_credit: "1000000",
} as const;
const creditAmountBindings = [
  ["CatalogItem", "credit_micros", "NonNegativeCreditMicros"],
  ["CreditAccount", "available_micros", "NonNegativeCreditMicros"],
  ["CreditAccount", "held_micros", "NonNegativeCreditMicros"],
  ["LedgerEntry", "delta_micros", "CreditMicros"],
  ["LedgerEntry", "balance_after_micros", "NonNegativeCreditMicros"],
  ["Subscription", "grant_micros", "NonNegativeCreditMicros"],
  ["Admission", "authorized_micros", "NonNegativeCreditMicros"],
] as const;
const nonCreditAmountBindings = [
  ["CatalogItem", "amount_minor", "NonNegativeDecimal"],
  ["Checkout", "amount_minor", "PositiveDecimal"],
  ["SettlementCreateRequest", "amount_minor", "PositiveDecimal"],
  ["Settlement", "amount_minor", "PositiveDecimal"],
  ["RefundCreateRequest", "amount_minor", "PositiveDecimal"],
  ["Refund", "amount_minor", "PositiveDecimal"],
  ["LedgerEntry", "sequence", "NonNegativeDecimal"],
] as const;

const contractSchemas = (document: JsonObject): JsonObject =>
  record(record(document.components).schemas);

// A test-only complete contract control: preserve the source's actual version,
// operations and every unrelated schema. Only install the approved unit slice.
// Negative cases exercise the real production validator, never a test validator.
const withApprovedCreditUnit = (document: JsonObject): JsonObject => {
  const copy = clone(document);
  const schemas = contractSchemas(copy);
  schemas.CreditMicros = {
    allOf: [{ $ref: "#/components/schemas/DecimalInteger" }],
    [creditUnitExtension]: { ...approvedCreditUnit },
  };
  schemas.NonNegativeCreditMicros = {
    allOf: [
      { $ref: "#/components/schemas/CreditMicros" },
      { $ref: "#/components/schemas/NonNegativeDecimal" },
    ],
  };
  for (const [schema, field, amountSchema] of creditAmountBindings)
    schemaProperties(copy, schema)[field] = {
      $ref: `#/components/schemas/${amountSchema}`,
    };
  return copy;
};

const extensionLocations = (value: unknown, path = "$"): string[] => {
  if (Array.isArray(value))
    return value.flatMap((item, index) =>
      extensionLocations(item, `${path}[${index}]`),
    );
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, nested]) => [
    ...(key === creditUnitExtension ? [`${path}.${key}`] : []),
    ...extensionLocations(nested, `${path}.${key}`),
  ]);
};

const rejectsCreditUnitMutation = (
  document: JsonObject,
  callback: (copy: JsonObject) => void,
): void => {
  expect(mutate(document, callback)).toEqual(
    expect.arrayContaining([expect.stringContaining("credit unit")]),
  );
};

describe("R38 Credit unit machine contract RED", () => {
  it("publishes exactly one complete Credit unit definition in the owner source", async () => {
    const document = await readContract();
    expect(extensionLocations(document)).toEqual([
      "$.components.schemas.CreditMicros.x-kokoro-credit-unit",
    ]);
    expect(
      record(contractSchemas(document).CreditMicros)[creditUnitExtension],
    ).toEqual(approvedCreditUnit);
  });

  it("composes signed and nonnegative Credit schemas from the original integer constraints", async () => {
    const schemas = contractSchemas(await readContract());
    expect(schemas.CreditMicros).toEqual({
      allOf: [{ $ref: "#/components/schemas/DecimalInteger" }],
      [creditUnitExtension]: approvedCreditUnit,
    });
    expect(schemas.NonNegativeCreditMicros).toEqual({
      allOf: [
        { $ref: "#/components/schemas/CreditMicros" },
        { $ref: "#/components/schemas/NonNegativeDecimal" },
      ],
    });
    expect(schemas.DecimalInteger).toEqual({
      type: "string",
      pattern: "^-?(?:0|[1-9][0-9]*)$",
    });
    expect(schemas.NonNegativeDecimal).toEqual({
      type: "string",
      pattern: "^(?:0|[1-9][0-9]*)$",
    });
    expect(schemas.PositiveDecimal).toEqual({
      type: "string",
      pattern: "^[1-9][0-9]*$",
    });
  });

  it.each(creditAmountBindings)(
    "binds owner source %s.%s to %s",
    async (schema, field, amountSchema) => {
      expect(schemaProperties(await readContract(), schema)[field]).toEqual({
        $ref: `#/components/schemas/${amountSchema}`,
      });
    },
  );

  it.each(nonCreditAmountBindings)(
    "preserves owner source cash/sequence %s.%s as %s",
    async (schema, field, amountSchema) => {
      expect(schemaProperties(await readContract(), schema)[field]).toEqual({
        $ref: `#/components/schemas/${amountSchema}`,
      });
    },
  );

  it("accepts the complete approved unit slice without changing unrelated contract facts", async () => {
    const original = await readContract();
    const document = withApprovedCreditUnit(original);
    expect(document.info).toEqual(original.info);
    expect(document.paths).toEqual(original.paths);
    for (const [schema, field] of nonCreditAmountBindings)
      expect(schemaProperties(document, schema)[field]).toEqual(
        schemaProperties(original, schema)[field],
      );
    expect(validateV2OpenApi(document)).toEqual([]);
  });

  it("rejects a missing Credit unit definition with a unit-specific diagnostic", async () => {
    const document = withApprovedCreditUnit(await readContract());
    rejectsCreditUnitMutation(document, (copy) => {
      delete record(contractSchemas(copy).CreditMicros)[creditUnitExtension];
    });
  });

  it.each(["CreditMicros", "NonNegativeCreditMicros"])(
    "rejects missing %s with a unit diagnostic, not merely an unknown-ref error",
    async (schema) => {
      const document = withApprovedCreditUnit(await readContract());
      rejectsCreditUnitMutation(document, (copy) => {
        delete contractSchemas(copy)[schema];
      });
    },
  );

  const duplicateLocations: ReadonlyArray<
    readonly [string, readonly string[]]
  > = [
    ["document root", []],
    [
      "nonnegative Credit schema",
      ["components", "schemas", "NonNegativeCreditMicros"],
    ],
    ["generic integer schema", ["components", "schemas", "DecimalInteger"]],
    [
      "Credit amount field",
      ["components", "schemas", "CatalogItem", "properties", "credit_micros"],
    ],
    [
      "cash amount field",
      ["components", "schemas", "CatalogItem", "properties", "amount_minor"],
    ],
  ];
  it.each(duplicateLocations)(
    "rejects duplicate unit metadata at %s even when both scales agree",
    async (_label, path) => {
      const document = withApprovedCreditUnit(await readContract());
      rejectsCreditUnitMutation(document, (copy) => {
        const node = path.reduce<JsonObject>(
          (parent, key) => record(parent[key]),
          copy,
        );
        node[creditUnitExtension] = { ...approvedCreditUnit };
      });
    },
  );

  const invalidMetadata: ReadonlyArray<readonly [string, JsonObject]> = [
    ["legacy 10000 scale", { micros_per_credit: "10000" }],
    ["numeric scale", { micros_per_credit: 1_000_000 }],
    ["empty scale", { micros_per_credit: "" }],
    ["leading-zero scale", { micros_per_credit: "01000000" }],
    ["whitespace scale", { micros_per_credit: " 1000000 " }],
    ["null scale", { micros_per_credit: null }],
    ["zero definition version", { definition_version: 0 }],
    ["unsupported definition version", { definition_version: 2 }],
    ["string definition version", { definition_version: "1" }],
    ["null definition version", { definition_version: null }],
    ["cash display unit", { display_unit: "USD" }],
    ["numeric display unit", { display_unit: 1 }],
    ["unknown metadata member", { fractional_digits: 6 }],
  ];
  it.each(invalidMetadata)(
    "rejects %s with a unit-specific diagnostic",
    async (_label, patch) => {
      const document = withApprovedCreditUnit(await readContract());
      rejectsCreditUnitMutation(document, (copy) => {
        record(contractSchemas(copy).CreditMicros)[creditUnitExtension] = {
          ...approvedCreditUnit,
          ...patch,
        };
      });
    },
  );

  it.each(["definition_version", "display_unit", "micros_per_credit"])(
    "rejects a unit definition missing %s",
    async (key) => {
      const document = withApprovedCreditUnit(await readContract());
      rejectsCreditUnitMutation(document, (copy) => {
        const metadata = record(
          record(contractSchemas(copy).CreditMicros)[creditUnitExtension],
        );
        delete metadata[key];
      });
    },
  );

  it.each(creditAmountBindings)(
    "rejects a lost Credit binding at %s.%s",
    async (schema, field, amountSchema) => {
      const document = withApprovedCreditUnit(await readContract());
      rejectsCreditUnitMutation(document, (copy) => {
        schemaProperties(copy, schema)[field] = {
          $ref: `#/components/schemas/${amountSchema === "CreditMicros" ? "DecimalInteger" : "NonNegativeDecimal"}`,
        };
      });
    },
  );

  const cashCreditMisbindings = nonCreditAmountBindings.flatMap(
    ([schema, field]) =>
      (["CreditMicros", "NonNegativeCreditMicros"] as const).map(
        (amountSchema) => [schema, field, amountSchema] as const,
      ),
  );
  it.each(cashCreditMisbindings)(
    "rejects cash/sequence %s.%s misbound to %s",
    async (schema, field, amountSchema) => {
      const document = withApprovedCreditUnit(await readContract());
      rejectsCreditUnitMutation(document, (copy) => {
        schemaProperties(copy, schema)[field] = {
          $ref: `#/components/schemas/${amountSchema}`,
        };
      });
    },
  );

  it.each(["CreditMicros", "NonNegativeCreditMicros"])(
    "rejects lost integer composition in %s",
    async (schema) => {
      const document = withApprovedCreditUnit(await readContract());
      rejectsCreditUnitMutation(document, (copy) => {
        record(contractSchemas(copy)[schema]).allOf = [];
      });
    },
  );
});

it("rejects a dotted component name colliding with an allowed Credit binding", async () => {
  const document = await readContract();
  contractSchemas(document)["CatalogItem.properties.credit_micros"] = {
    type: "string",
  };
  expect(validateV2OpenApi(document)).toEqual([]);
  rejectsCreditUnitMutation(document, (copy) => {
    contractSchemas(copy)["CatalogItem.properties.credit_micros"] = {
      $ref: "#/components/schemas/CreditMicros",
    };
  });
});

it("rejects a shared Credit reference at an extra YAML alias occurrence", async () => {
  const { stringify } = await import("yaml");
  const document = await readContract();
  contractSchemas(document).ExtraCashAlias = schemaProperties(
    document,
    "CatalogItem",
  ).amount_minor;
  const valid = record(parse(stringify(document)) as unknown);
  expect(contractSchemas(valid).ExtraCashAlias).toBe(
    schemaProperties(valid, "CatalogItem").amount_minor,
  );
  expect(validateV2OpenApi(valid)).toEqual([]);

  contractSchemas(document).ExtraCreditAlias = schemaProperties(
    document,
    "CatalogItem",
  ).credit_micros;
  const decoded = record(parse(stringify(document)) as unknown);
  expect(contractSchemas(decoded).ExtraCreditAlias).toBe(
    schemaProperties(decoded, "CatalogItem").credit_micros,
  );
  expect(validateV2OpenApi(decoded)).toEqual(
    expect.arrayContaining([expect.stringContaining("credit unit")]),
  );
});
