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
    expect(record(document.info).version).toBe("2.0.2");
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

// R61 target assertions are append-only; the original 72-test prefix is frozen.
const personalReadPaths = [
  "/v2/billing/me/credit-account",
  "/v2/billing/me/credit-ledger",
] as const;
const personalReadStatuses = ["200", "400", "401", "403", "404", "500", "503"];
const personalReadSecurity = [
  { tenantContext: [], userBearer: [] },
  {
    serviceCaller: [],
    internalSecret: [],
    serviceBearer: [],
    tenantContext: [],
    subjectContext: [],
  },
];
const personalIdentityParameters = [
  ["PersonalTenantId", "x-kokoro-tenant-id", true, 1022],
  ["PersonalSubjectId", "x-kokoro-subject", false, 1363],
] as const;
// Lexical canonical base64url only; fatal UTF-8/semantic identity tests follow
// in the separately authorized codec phase, not in this contract test.
const personalIdentityPattern =
  "^u1\\.(?=[A-Za-z0-9_-])(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2}[AEIMQUYcgkosw048]|[A-Za-z0-9_-][AQgw])?$(?![\\s\\S])";
const personalRead = (document: JsonObject, path: string): JsonObject =>
  record(record(record(document.paths)[path]).get);
const resolvePersonalRef = (
  document: JsonObject,
  value: unknown,
): JsonObject => {
  const node = record(value);
  if (node.$ref === undefined) return node;
  expect(typeof node.$ref).toBe("string");
  const pointer = node.$ref as string;
  expect(pointer.startsWith("#/")).toBe(true);
  const resolved = pointer
    .slice(2)
    .split("/")
    .reduce<unknown>(
      (current, part) =>
        record(current)[part.replaceAll("~1", "/").replaceAll("~0", "~")],
      document,
    );
  expect(resolved, `unresolved local ref ${pointer}`).toBeDefined();
  return record(resolved);
};
const personalParameters = (
  document: JsonObject,
  path: string,
): JsonObject[] => {
  const parameters = personalRead(document, path).parameters;
  expect(Array.isArray(parameters)).toBe(true);
  return (parameters as unknown[]).map((parameter) =>
    resolvePersonalRef(document, parameter),
  );
};
const personalParameterComponent = (
  document: JsonObject,
  name: string,
): JsonObject => {
  const parameters = record(record(document.components).parameters);
  expect(
    parameters,
    `missing target identity parameter ${name}`,
  ).toHaveProperty(name);
  return resolvePersonalRef(document, parameters[name]);
};
const personalResponse = (
  document: JsonObject,
  path: string,
  status: string,
): JsonObject => record(record(personalRead(document, path).responses)[status]);

// A complete target-document positive control for the real production checker.
// It changes only the approved two-read slice; it is not a replacement checker.
const withApprovedPersonalReads = (document: JsonObject): JsonObject => {
  const copy = clone(document);
  record(copy.info).version = "2.0.2";
  const components = record(copy.components);
  for (const [
    name,
    header,
    required,
    maxLength,
  ] of personalIdentityParameters) {
    record(components.parameters)[name] = {
      name: header,
      in: "header",
      required,
      schema: {
        type: "string",
        minLength: 5,
        maxLength,
        pattern: personalIdentityPattern,
      },
    };
  }
  record(components.headers).CacheControlNoStore = {
    schema: { type: "string", const: "no-store" },
  };
  for (const path of personalReadPaths) {
    const operation = personalRead(copy, path);
    operation["x-kokoro-permission"] = "authenticated-user-or-web-bff";
    operation["x-kokoro-identity-transport"] = "personal-identity-u1";
    operation[personalAuthSelectionExtension] = structuredClone(
      approvedPersonalAuthSelection,
    );
    operation.security = structuredClone(personalReadSecurity);
    operation.parameters = [
      { $ref: "#/components/parameters/PersonalTenantId" },
      { $ref: "#/components/parameters/PersonalSubjectId" },
      {
        name: "x-kokoro-service",
        in: "header",
        required: false,
        schema: { type: "string", const: "web-bff" },
      },
      ...(path.endsWith("credit-ledger")
        ? [
            { $ref: "#/components/parameters/Limit" },
            { $ref: "#/components/parameters/Cursor" },
          ]
        : []),
    ];
    for (const status of personalReadStatuses) {
      record(personalResponse(copy, path, status).headers)["cache-control"] = {
        $ref: "#/components/headers/CacheControlNoStore",
      };
    }
  }
  return copy;
};
const rejectPersonalReadMutation = (
  document: JsonObject,
  callback: (copy: JsonObject) => void,
): void => {
  expect(
    validateV2OpenApi(document),
    "approved target positive control failed; mutation guard not reached",
  ).toEqual([]);
  expect(mutate(document, callback)).not.toEqual([]);
};
const stableContractJson = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableContractJson);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(record(value))
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, nested]) => [key, stableContractJson(nested)]),
  );
};

describe("R61 personal-read source contract target", () => {
  it("publishes the approved experimental 2.0.2 target independently of other fields", async () => {
    expect(record((await readContract()).info).version).toBe("2.0.2");
  });

  for (const path of personalReadPaths) {
    it(`${path} grants only the approved JWT-or-web-bff read permission`, async () => {
      expect(
        personalRead(await readContract(), path)["x-kokoro-permission"],
      ).toBe("authenticated-user-or-web-bff");
    });

    it(`${path} keeps independent JWT OR all five empty-scope machine factors`, async () => {
      expect(personalRead(await readContract(), path).security).toEqual(
        personalReadSecurity,
      );
    });

    it(`${path} fixes the delegated caller to web-bff without making it mandatory for JWT`, async () => {
      const document = await readContract();
      const caller = personalParameters(document, path).find(
        (parameter) => parameter.name === "x-kokoro-service",
      );
      expect(caller, "missing fixed web-bff caller constraint").toBeDefined();
      expect(record(caller)).toMatchObject({
        in: "header",
        required: false,
        schema: { type: "string", const: "web-bff" },
      });
    });

    it(`${path} declares only the approved personal-identity-u1 profile`, async () => {
      expect(
        personalRead(await readContract(), path)["x-kokoro-identity-transport"],
      ).toBe("personal-identity-u1");
    });

    for (const [name] of personalIdentityParameters) {
      it(`${path} resolves the dedicated ${name} parameter instead of shared raw identity`, async () => {
        const document = await readContract();
        const parameters = personalRead(document, path).parameters as unknown[];
        expect(parameters).toContainEqual({
          $ref: `#/components/parameters/${name}`,
        });
        expect(parameters).not.toContainEqual({
          $ref: "#/components/parameters/TenantId",
        });
        expect(personalParameters(document, path)).toContainEqual(
          personalParameterComponent(document, name),
        );
      });
    }

    for (const status of personalReadStatuses) {
      it(`${path} ${status} resolves an immutable no-store response header`, async () => {
        const document = await readContract();
        const headers = record(
          personalResponse(document, path, status).headers,
        );
        expect(headers, "missing target no-store header").toHaveProperty(
          "cache-control",
        );
        expect(record(headers["cache-control"]).$ref).toBe(
          "#/components/headers/CacheControlNoStore",
        );
        expect(resolvePersonalRef(document, headers["cache-control"])).toEqual({
          schema: { type: "string", const: "no-store" },
        });
      });
    }

    it(`${path} retains request-ID refs and the exact seven safe status contracts`, async () => {
      const document = await readContract();
      expect(
        Object.keys(record(personalRead(document, path).responses)),
      ).toEqual(personalReadStatuses);
      const errors: Record<string, [string, boolean]> = {
        "400": ["billing.invalid_request", false],
        "401": ["billing.unauthenticated", false],
        "403": ["billing.forbidden", false],
        "404": ["billing.not_found", false],
        "500": ["billing.internal_error", false],
        "503": ["billing.dependency_unavailable", true],
      };
      for (const status of personalReadStatuses) {
        const response = personalResponse(document, path, status);
        const headers = record(response.headers);
        expect(headers["x-request-id"]).toEqual({
          $ref: "#/components/headers/RequestId",
        });
        expect(headers).not.toHaveProperty("x-kokoro-request-id");
        expect(
          record(resolvePersonalRef(document, headers["x-request-id"]).schema),
        ).toEqual({ type: "string", minLength: 1, maxLength: 255 });
        const schema = record(
          record(record(response.content)["application/json"]).schema,
        );
        const successRef = path.endsWith("credit-account")
          ? "CreditAccountResponse"
          : "CreditLedgerResponse";
        expect(schema.$ref).toBe(
          `#/components/schemas/${status === "200" ? successRef : "ErrorResponse"}`,
        );
        expect(resolvePersonalRef(document, schema)).toBeDefined();
        if (status !== "200") {
          const expected = errors[status];
          expect(expected).toBeDefined();
          const [code, retryable] = expected as [string, boolean];
          expect(response["x-kokoro-errors"]).toEqual([{ code, retryable }]);
        }
      }
    });

    it(`${path} stays read-only with exact permitted parameter names and unchanged paging`, async () => {
      const document = await readContract();
      const operation = personalRead(document, path);
      expect(operation).toMatchObject({
        "x-kokoro-owner": "kokoro-billing",
        "x-kokoro-visibility": "internal-owner",
        "x-kokoro-stability": "experimental",
        "x-kokoro-idempotency": "read-only",
        operationId: path.endsWith("credit-account")
          ? "getMyCreditAccount"
          : "getMyCreditLedger",
      });
      expect(operation).not.toHaveProperty("requestBody");
      const parameters = personalParameters(document, path);
      expect(parameters.map((parameter) => parameter.name).sort()).toEqual(
        [
          "x-kokoro-tenant-id",
          "x-kokoro-subject",
          "x-kokoro-service",
          ...(path.endsWith("credit-ledger") ? ["limit", "cursor"] : []),
        ].sort(),
      );
      if (path.endsWith("credit-ledger")) {
        expect(
          parameters.find((parameter) => parameter.name === "limit"),
        ).toEqual({
          name: "limit",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 1, maximum: 100, default: 50 },
        });
        expect(
          parameters.find((parameter) => parameter.name === "cursor"),
        ).toEqual({
          name: "cursor",
          in: "query",
          required: false,
          schema: { type: "string", minLength: 1, maxLength: 2048 },
        });
      }
    });
  }

  for (const [
    name,
    header,
    required,
    maxLength,
  ] of personalIdentityParameters) {
    it(`${name} preserves its header identity, alternative-branch requirement and encoded bounds`, async () => {
      const parameter = personalParameterComponent(await readContract(), name);
      expect(parameter).toMatchObject({ name: header, in: "header", required });
      expect(record(parameter.schema)).toMatchObject({
        type: "string",
        minLength: 5,
        maxLength,
      });
    });

    it(`${name} describes canonical u1 lexical wire, not raw/percent/padded/alias input`, async () => {
      const schema = record(
        personalParameterComponent(await readContract(), name).schema,
      );
      expect(typeof schema.pattern, "missing canonical u1 pattern").toBe(
        "string",
      );
      const pattern = new RegExp(schema.pattern as string);
      for (const identity of [
        "a",
        "tenant-a",
        "\uFEFFsubject-a",
        "😀".repeat(name === "PersonalTenantId" ? 191 : 255),
      ]) {
        const wire = `u1.${Buffer.from(identity, "utf8").toString("base64url")}`;
        expect(
          pattern.test(wire),
          `legal encoded lexical wire for ${name}`,
        ).toBe(true);
        expect(wire.length).toBeGreaterThanOrEqual(5);
        expect(wire.length).toBeLessThanOrEqual(maxLength);
      }
      for (const wire of [
        "tenant-a",
        "u2.YQ",
        "u1.",
        "u1.YQ=",
        "u1.%61",
        "u1.YQ\n",
        "u1.YQ ",
        "u1.YQ,YQ",
        "u1.A",
        "u1.YR",
        "u1.YWJ",
      ]) {
        expect(
          pattern.test(wire),
          `reject noncanonical lexical wire ${JSON.stringify(wire)}`,
        ).toBe(false);
      }
    });
  }

  it("preserves the entire unrelated contract projection, 24 inventory, global schemes and Credit units", async () => {
    const document = await readContract();
    const projection = clone(document);
    delete record(projection.info).version;
    for (const path of personalReadPaths)
      delete record(record(projection.paths)[path]).get;
    for (const [name] of personalIdentityParameters)
      delete record(record(projection.components).parameters)[name];
    delete record(record(projection.components).headers).CacheControlNoStore;
    const { createHash } = await import("node:crypto");
    expect(
      createHash("sha256")
        .update(JSON.stringify(stableContractJson(projection)))
        .digest("hex"),
    ).toBe("58723403229da6d719ae0f3175ef79a6848c0209e14648f5656b37457e0123c6");
    const count = Object.values(record(document.paths)).reduce<number>(
      (total, item) =>
        total +
        Object.keys(record(item)).filter((method) =>
          ["get", "post", "put", "patch", "delete"].includes(method),
        ).length,
      0,
    );
    expect(count).toBe(24);
  });
});

describe("R61 production validator personal-read guards", () => {
  it("accepts the complete approved target before any mutation is evaluated", async () => {
    expect(
      validateV2OpenApi(withApprovedPersonalReads(await readContract())),
    ).toEqual([]);
  });

  for (const path of personalReadPaths) {
    for (const factor of [
      "serviceCaller",
      "internalSecret",
      "serviceBearer",
      "tenantContext",
      "subjectContext",
    ]) {
      it(`${path} rejects a machine branch missing ${factor} after a legal target control`, async () => {
        rejectPersonalReadMutation(
          withApprovedPersonalReads(await readContract()),
          (copy) => {
            const branches = personalRead(copy, path).security as JsonObject[];
            delete record(branches[1])[factor];
          },
        );
      });
    }

    const operationMutations: [string, (operation: JsonObject) => void][] = [
      [
        "an extra partial-machine OR branch",
        (operation) => {
          (operation.security as JsonObject[]).push({ serviceBearer: [] });
        },
      ],
      [
        "missing independent JWT branch",
        (operation) => {
          (operation.security as JsonObject[]).shift();
        },
      ],
      [
        "nonempty machine security scopes",
        (operation) => {
          record((operation.security as JsonObject[])[1]).subjectContext = [
            "read",
          ];
        },
      ],
      [
        "raw identity profile",
        (operation) => {
          operation["x-kokoro-identity-transport"] = "raw";
        },
      ],
      [
        "broadened permission",
        (operation) => {
          operation["x-kokoro-permission"] = "authenticated-user";
        },
      ],
      [
        "old shared tenant parameter",
        (operation) => {
          (operation.parameters as JsonObject[])[0] = {
            $ref: "#/components/parameters/TenantId",
          };
        },
      ],
      [
        "missing delegated subject parameter",
        (operation) => {
          (operation.parameters as JsonObject[]).splice(1, 1);
        },
      ],
      [
        "another delegated caller",
        (operation) => {
          record(
            record((operation.parameters as JsonObject[])[2]).schema,
          ).const = "agent";
        },
      ],
      [
        "an arbitrary identity selector",
        (operation) => {
          (operation.parameters as JsonObject[]).push({
            name: "subject_id",
            in: "query",
            schema: { type: "string" },
          });
        },
      ],
      [
        "a GET request body",
        (operation) => {
          operation.requestBody = {
            content: { "application/json": { schema: { type: "object" } } },
          };
        },
      ],
    ];
    for (const [name, callback] of operationMutations) {
      it(`${path} rejects ${name} after a legal target control`, async () => {
        rejectPersonalReadMutation(
          withApprovedPersonalReads(await readContract()),
          (copy) => callback(personalRead(copy, path)),
        );
      });
    }

    for (const status of personalReadStatuses) {
      it(`${path} rejects missing no-store at ${status} after a legal target control`, async () => {
        rejectPersonalReadMutation(
          withApprovedPersonalReads(await readContract()),
          (copy) => {
            delete record(personalResponse(copy, path, status).headers)[
              "cache-control"
            ];
          },
        );
      });
    }
    it(`${path} rejects missing request ID after a legal target control`, async () => {
      rejectPersonalReadMutation(
        withApprovedPersonalReads(await readContract()),
        (copy) => {
          delete record(personalResponse(copy, path, "401").headers)[
            "x-request-id"
          ];
        },
      );
    });
    it(`${path} rejects unsafe error response refs after a legal target control`, async () => {
      rejectPersonalReadMutation(
        withApprovedPersonalReads(await readContract()),
        (copy) => {
          record(
            record(
              record(personalResponse(copy, path, "500").content)[
                "application/json"
              ],
            ).schema,
          ).$ref = "#/components/schemas/CreditAccountResponse";
        },
      );
    });
  }

  for (const [name] of personalIdentityParameters) {
    for (const [field, invalid] of [
      ["minLength", 1],
      ["maxLength", 191],
      ["pattern", "^.*$"],
    ] as const) {
      it(`rejects ${name} ${field} drift after a legal target control`, async () => {
        rejectPersonalReadMutation(
          withApprovedPersonalReads(await readContract()),
          (copy) => {
            record(personalParameterComponent(copy, name).schema)[field] =
              invalid;
          },
        );
      });
    }
    it(`rejects ${name} incorrect branch-level required flag after a legal target control`, async () => {
      rejectPersonalReadMutation(
        withApprovedPersonalReads(await readContract()),
        (copy) => {
          const parameter = personalParameterComponent(copy, name);
          parameter.required = !parameter.required;
        },
      );
    });
  }

  it("rejects mutable cache policy after a legal target control", async () => {
    rejectPersonalReadMutation(
      withApprovedPersonalReads(await readContract()),
      (copy) => {
        record(
          record(record(copy.components).headers).CacheControlNoStore,
        ).schema = { type: "string" };
      },
    );
  });
  it("rejects applying personal u1 profile to unrelated operations after a legal target control", async () => {
    rejectPersonalReadMutation(
      withApprovedPersonalReads(await readContract()),
      (copy) => {
        personalRead(copy, "/v2/billing/me/subscriptions")[
          "x-kokoro-identity-transport"
        ] = "personal-identity-u1";
      },
    );
  });
  it("rejects widening the shared raw TenantId after a legal target control", async () => {
    rejectPersonalReadMutation(
      withApprovedPersonalReads(await readContract()),
      (copy) => {
        record(
          record(record(record(copy.components).parameters).TenantId).schema,
        ).maxLength = 1022;
      },
    );
  });
});

// R64 append-only auth-selection evidence; the complete 168-test prefix stays
// frozen until the separate machine GREEN and legal-control migration grant.
const personalAuthSelectionExtension = "x-kokoro-auth-selection";
const approvedPersonalAuthSelection = {
  machine_markers: [
    "x-kokoro-service",
    "x-kokoro-internal-secret",
    "x-kokoro-subject",
  ],
  service_bearer_selects_machine: true,
  machine_partial_response: 403,
  machine_to_user_fallback: false,
};
const withApprovedPersonalAuthSelection = (
  document: JsonObject,
): JsonObject => {
  const copy = clone(withApprovedPersonalReads(document));
  for (const path of personalReadPaths)
    personalRead(copy, path)[personalAuthSelectionExtension] = structuredClone(
      approvedPersonalAuthSelection,
    );
  return copy;
};

describe("R64 personal-read auth-selection machine facts", () => {
  for (const path of personalReadPaths) {
    it(
      path +
        " declares exact presence-based machine selection and forbids partial JWT downgrade",
      async () => {
        expect(
          personalRead(await readContract(), path)[
            personalAuthSelectionExtension
          ],
        ).toEqual(approvedPersonalAuthSelection);
      },
    );
  }

  it("accepts the complete selection target with the production checker before mutations", async () => {
    expect(
      validateV2OpenApi(
        withApprovedPersonalAuthSelection(await readContract()),
      ),
    ).toEqual([]);
  });

  for (const path of personalReadPaths) {
    it(
      path +
        " rejects a missing selection extension after a legal target control",
      async () => {
        rejectPersonalReadMutation(
          withApprovedPersonalAuthSelection(await readContract()),
          (copy) => {
            delete personalRead(copy, path)[personalAuthSelectionExtension];
          },
        );
      },
    );

    for (const marker of approvedPersonalAuthSelection.machine_markers) {
      it(
        path +
          " rejects missing dedicated marker " +
          marker +
          " after a legal target control",
        async () => {
          rejectPersonalReadMutation(
            withApprovedPersonalAuthSelection(await readContract()),
            (copy) => {
              const selection = record(
                personalRead(copy, path)[personalAuthSelectionExtension],
              );
              selection.machine_markers = (
                selection.machine_markers as string[]
              ).filter((candidate) => candidate !== marker);
            },
          );
        },
      );
    }

    const selectionMutations: [string, (selection: JsonObject) => void][] = [
      [
        "an unknown machine marker",
        (selection) => {
          (selection.machine_markers as string[])[0] = "x-untrusted-actor";
        },
      ],
      [
        "shared tenant as a machine selector",
        (selection) => {
          (selection.machine_markers as string[]).push("x-kokoro-tenant-id");
        },
      ],
      [
        "arbitrary Authorization as a machine selector",
        (selection) => {
          (selection.machine_markers as string[]).push("authorization");
        },
      ],
      [
        "duplicate dedicated markers",
        (selection) => {
          (selection.machine_markers as string[]).push("x-kokoro-service");
        },
      ],
      [
        "an empty marker set",
        (selection) => {
          selection.machine_markers = [];
        },
      ],
      [
        "a scalar marker instead of the closed list",
        (selection) => {
          selection.machine_markers = "x-kokoro-service";
        },
      ],
      [
        "omitted configured service-Bearer selection",
        (selection) => {
          delete selection.service_bearer_selects_machine;
        },
      ],
      [
        "disabled configured service-Bearer selection",
        (selection) => {
          selection.service_bearer_selects_machine = false;
        },
      ],
      [
        "allowed machine-to-user fallback",
        (selection) => {
          selection.machine_to_user_fallback = true;
        },
      ],
      [
        "omitted machine-to-user fallback prohibition",
        (selection) => {
          delete selection.machine_to_user_fallback;
        },
      ],
      [
        "partial authentication returning 401 instead of forbidden 403",
        (selection) => {
          selection.machine_partial_response = 401;
        },
      ],
      [
        "omitted partial-machine status",
        (selection) => {
          delete selection.machine_partial_response;
        },
      ],
      [
        "an extra truthiness-only marker selection rule",
        (selection) => {
          selection.machine_markers_require_truthy = true;
        },
      ],
    ];
    for (const [name, callback] of selectionMutations) {
      it(
        path + " rejects " + name + " after a legal target control",
        async () => {
          rejectPersonalReadMutation(
            withApprovedPersonalAuthSelection(await readContract()),
            (copy) =>
              callback(
                record(
                  personalRead(copy, path)[personalAuthSelectionExtension],
                ),
              ),
          );
        },
      );
    }
  }

  it("rejects personal auth selection leaking onto an unrelated operation after a legal target control", async () => {
    rejectPersonalReadMutation(
      withApprovedPersonalAuthSelection(await readContract()),
      (copy) => {
        personalRead(copy, "/v2/billing/me/subscriptions")[
          personalAuthSelectionExtension
        ] = structuredClone(approvedPersonalAuthSelection);
      },
    );
  });
});

describe("R67 official Billing API artifacts", () => {
  it("provides the approved official generation and closed artifact entry points", async () => {
    for (const name of [
      "generate-billing-api.ts",
      "billing-api-artifacts.ts",
    ]) {
      const source = await readFile(
        join(process.cwd(), "scripts", name),
        "utf8",
      );
      expect(source.length).toBeGreaterThan(0);
    }
  });
});

import { afterAll, beforeAll } from "vitest";
import type * as BillingApiArtifacts from "../../scripts/billing-api-artifacts.js";
import type * as BillingApiGenerator from "../../scripts/generate-billing-api.js";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { stringify } from "yaml";

describe("R67 generated schema semantics and provenance", () => {
  let directory: string;
  let sourceText: string;
  let officialFiles: Record<string, string>;
  let artifactFiles: Record<string, string>;
  let artifacts: typeof BillingApiArtifacts;
  let generator: typeof BillingApiGenerator;

  beforeAll(async () => {
    artifacts = await import("../../scripts/billing-api-artifacts.js");
    generator = await import("../../scripts/generate-billing-api.js");
    directory = await mkdtemp(join(tmpdir(), "billing-r67-test-"));
    sourceText = await readFile(target, "utf8");
    await generator.generateBillingApiArtifacts({
      rootDirectory: process.cwd(),
      outputDirectory: directory,
      mode: "write",
    });
    artifactFiles = {};
    for (const name of artifacts.billingApiArtifactNames) {
      artifactFiles[name] = await readFile(join(directory, name), "utf8");
    }
    officialFiles = Object.fromEntries(
      artifacts.billingApiOfficialNames.map((name) => [
        name,
        artifactFiles[name] ?? "",
      ]),
    );
  });
  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  const input = () => ({ sourceText, officialFiles });
  const validProvenance = () => artifacts.createBillingApiProvenance(input());

  it("exports exactly the 43 original objects with unchanged refs and unit metadata", async () => {
    const schemas = contractSchemas(record(parse(sourceText) as unknown));
    const exports: unknown = await import(
      pathToFileURL(join(directory, "schemas.gen.ts")).href
    );
    const schemaExports = record(exports);
    expect(Object.keys(schemas)).toHaveLength(43);
    expect(Object.keys(schemaExports).sort()).toEqual(
      Object.keys(schemas)
        .map((name) => name + "Schema")
        .sort(),
    );
    for (const [name, schema] of Object.entries(schemas)) {
      expect(stableContractJson(schemaExports[name + "Schema"])).toEqual(
        stableContractJson(schema),
      );
    }
    const provenance = validProvenance();
    expect(provenance.source.version).toBe("2.0.2");
    expect(provenance.source.sha256).toBe(
      createHash("sha256").update(sourceText).digest("hex"),
    );
    expect(provenance.schema_bindings).toHaveProperty(
      "CreditMicros",
      "CreditMicrosSchema",
    );
    artifacts.assertBillingApiProvenance({ ...input(), provenance });
  });

  it("produces the same complete bytes on a second official run", async () => {
    await generator.generateBillingApiArtifacts({
      rootDirectory: process.cwd(),
      outputDirectory: directory,
      mode: "write",
    });
    expect((await readdir(directory)).sort()).toEqual(
      [...artifacts.billingApiArtifactNames].sort(),
    );
    const second: Record<string, string> = {};
    for (const name of artifacts.billingApiArtifactNames)
      second[name] = await readFile(join(directory, name), "utf8");
    expect(second).toEqual(artifactFiles);
    artifacts.assertBillingApiArtifactBytes(second, artifactFiles);
  });

  it("checks without modifying even a drifted destination", async () => {
    await generator.generateBillingApiArtifacts({
      rootDirectory: process.cwd(),
      outputDirectory: directory,
      mode: "check",
    });
    const original = artifactFiles["types.gen.ts"] ?? "";
    await writeFile(join(directory, "types.gen.ts"), original + "\n");
    try {
      await expect(
        generator.generateBillingApiArtifacts({
          rootDirectory: process.cwd(),
          outputDirectory: directory,
          mode: "check",
        }),
      ).rejects.toThrow("types.gen.ts");
      expect(await readFile(join(directory, "types.gen.ts"), "utf8")).toBe(
        original + "\n",
      );
    } finally {
      await writeFile(join(directory, "types.gen.ts"), original);
    }
  });

  for (const [label, suffix] of [
    [
      "unknown exported component",
      "\nexport const UnknownSchema = {} as const;\n",
    ],
    ["non-const export", "\nexport let UnknownSchema = {};\n"],
    ["executable export", "\nexport const UnknownSchema = (() => ({}))();\n"],
    ["duplicate export", "\nexport const UuidSchema = {} as const;\n"],
  ]) {
    it("rejects " + label + " after a valid official control", () => {
      validProvenance();
      expect(() =>
        artifacts.createBillingApiProvenance({
          sourceText,
          officialFiles: {
            ...officialFiles,
            "schemas.gen.ts": (officialFiles["schemas.gen.ts"] ?? "") + suffix,
          },
        }),
      ).toThrow();
    });
  }

  for (const [label, from, to] of [
    ["missing binding", "export const UuidSchema", "const UuidSchema"],
    ["wrong binding", "export const UuidSchema", "export const OtherSchema"],
    [
      "unknown generated ref",
      "#/components/schemas/DecimalInteger",
      "#/components/schemas/Unknown",
    ],
    [
      "rewritten ref",
      "#/components/schemas/DecimalInteger",
      "#/DecimalInteger",
    ],
    [
      "credit unit drift",
      'micros_per_credit: "1000000"',
      'micros_per_credit: "1000"',
    ],
    ["schema constraint drift", 'format: "uuid"', 'format: "uri"'],
  ]) {
    it("rejects " + label + " after a valid official control", () => {
      validProvenance();
      const schemaText = officialFiles["schemas.gen.ts"] ?? "";
      expect(schemaText).toContain(from);
      expect(() =>
        artifacts.createBillingApiProvenance({
          sourceText,
          officialFiles: {
            ...officialFiles,
            "schemas.gen.ts": schemaText.replace(from ?? "", to ?? ""),
          },
        }),
      ).toThrow();
    });
  }

  it("rejects an unknown source schema ref before generation", () => {
    validProvenance();
    const document = record(parse(sourceText) as unknown);
    record(contractSchemas(document).Uuid).allOf = [
      { $ref: "#/components/schemas/Unknown" },
    ];
    expect(() =>
      artifacts.createBillingApiProvenance({
        sourceText: stringify(document),
        officialFiles,
      }),
    ).toThrow();
  });
  it("rejects replacement components with the same count", () => {
    validProvenance();
    const document = record(parse(sourceText) as unknown);
    const schemas = contractSchemas(document);
    schemas.Unknown = schemas.Uuid;
    delete schemas.Uuid;
    expect(() =>
      artifacts.createBillingApiProvenance({
        sourceText: stringify(document),
        officialFiles,
      }),
    ).toThrow();
  });

  for (const mutation of [
    (p: JsonObject) => {
      record(p.source).version = "2.0.1";
    },
    (p: JsonObject) => {
      record(p.source).sha256 = "0".repeat(64);
    },
    (p: JsonObject) => {
      record(p.generator).version = "0.98.0";
    },
    (p: JsonObject) => {
      record(p.generator).plugins = ["@hey-api/sdk"];
    },
    (p: JsonObject) => {
      record(p.schema_bindings).Uuid = "OtherSchema";
    },
    (p: JsonObject) => {
      delete record(p.schema_bindings).Uuid;
    },
    (p: JsonObject) => {
      record(p.schema_bindings).Unknown = "UnknownSchema";
    },
    (p: JsonObject) => {
      record(record(p.outputs)["types.gen.ts"]).sha256 = "0".repeat(64);
    },
    (p: JsonObject) => {
      record(record(p.outputs)["index.ts"]).bytes = 0;
    },
    (p: JsonObject) => {
      p.unknown = true;
    },
  ]) {
    it("rejects a tampered closed provenance after a valid control", () => {
      const provenance = validProvenance();
      artifacts.assertBillingApiProvenance({ ...input(), provenance });
      const changed = record(structuredClone(provenance));
      mutation(changed);
      expect(() =>
        artifacts.assertBillingApiProvenance({
          ...input(),
          provenance: changed,
        }),
      ).toThrow();
    });
  }

  for (const name of [
    "index.ts",
    "types.gen.ts",
    "schemas.gen.ts",
    "provenance.json",
  ]) {
    it("rejects whole-byte drift in " + name, () => {
      artifacts.assertBillingApiArtifactBytes(artifactFiles, artifactFiles);
      expect(() =>
        artifacts.assertBillingApiArtifactBytes(
          {
            ...artifactFiles,
            [name]: (artifactFiles[name] ?? "") + "\n",
          },
          artifactFiles,
        ),
      ).toThrow(name);
    });
  }
  it("rejects extra or missing files instead of silently ignoring them", () => {
    artifacts.assertBillingApiArtifactBytes(artifactFiles, artifactFiles);
    expect(() =>
      artifacts.assertBillingApiArtifactBytes(
        { ...artifactFiles, "sdk.gen.ts": "" },
        artifactFiles,
      ),
    ).toThrow();
    const missing = { ...artifactFiles };
    delete missing["index.ts"];
    expect(() =>
      artifacts.assertBillingApiArtifactBytes(missing, artifactFiles),
    ).toThrow();
  });
});

it("R67 rejects invalid UTF-8 bytes rather than comparing lossy decoded text", async () => {
  const { generateBillingApiArtifacts } =
    await import("../../scripts/generate-billing-api.js");
  const directory = await mkdtemp(join(tmpdir(), "billing-r67-invalid-utf8-"));
  try {
    await generateBillingApiArtifacts({
      rootDirectory: process.cwd(),
      outputDirectory: directory,
      mode: "write",
    });
    await generateBillingApiArtifacts({
      rootDirectory: process.cwd(),
      outputDirectory: directory,
      mode: "check",
    });
    const file = join(directory, "types.gen.ts");
    const original = await readFile(file);
    const changed = Buffer.concat([original, Buffer.from([0xff])]);
    await writeFile(file, changed);
    await expect(
      generateBillingApiArtifacts({
        rootDirectory: process.cwd(),
        outputDirectory: directory,
        mode: "check",
      }),
    ).rejects.toThrow("UTF-8");
    expect(await readFile(file)).toEqual(changed);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("R67 checks the repository artifacts against fresh official output in the normal pure gate", async () => {
  const { generateBillingApiArtifacts } =
    await import("../../scripts/generate-billing-api.js");
  await generateBillingApiArtifacts({
    rootDirectory: process.cwd(),
    mode: "check",
  });
});
