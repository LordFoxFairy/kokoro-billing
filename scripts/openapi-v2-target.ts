type JsonObject = Record<string, unknown>;

const methods = new Set(["get", "post", "put", "patch", "delete"]);
const expectedOperations = new Map<string, string>([
  ["get /healthz", "getHealth"],
  ["get /readyz", "getReadiness"],
  ["get /metrics", "getMetrics"],
  ["get /v2/commerce/catalog", "getCatalog"],
  ["get /v2/billing/me/credit-account", "getMyCreditAccount"],
  ["get /v2/billing/me/credit-ledger", "getMyCreditLedger"],
  ["get /v2/billing/me/subscriptions", "getMySubscriptions"],
  ["post /v2/internal/billing/admissions", "createAdmission"],
  ["get /v2/internal/billing/admissions/{admission_id}", "getAdmission"],
  [
    "post /v2/internal/billing/admissions/{admission_id}/capture",
    "captureAdmission",
  ],
  [
    "post /v2/internal/billing/admissions/{admission_id}/release",
    "releaseAdmission",
  ],
  ["post /v2/internal/billing/execution-events", "acceptExecutionEvent"],
  [
    "get /v2/internal/billing/execution-events/{execution_event_id}",
    "getExecutionEvent",
  ],
  ["post /v2/billing/checkouts", "createCheckout"],
  ["get /v2/billing/checkouts/{checkout_id}", "getCheckout"],
  ["post /v2/internal/payment/settlements", "createSettlement"],
  ["get /v2/internal/payment/settlements/{settlement_id}", "getSettlement"],
  ["post /v2/internal/payment/refunds", "createInternalRefund"],
  ["get /v2/internal/payment/refunds/{refund_id}", "getRefund"],
  ["post /v2/admin/billing/refunds", "createAdminRefund"],
  ["post /v2/internal/credit-holds/expire", "expireCreditHolds"],
  ["post /v2/webhooks/payment/stripe", "acceptStripeWebhook"],
  ["post /v2/webhooks/payment/alipay", "acceptAlipayWebhook"],
  ["post /v2/webhooks/payment/wechat", "acceptWechatWebhook"],
]);
const expectedPermissionByOperation = new Map<string, string>([
  ["getHealth", "none"],
  ["getReadiness", "none"],
  ["getMetrics", "none"],
  ["getCatalog", "authenticated-user-or-web-bff"],
  ["getMyCreditAccount", "authenticated-user"],
  ["getMyCreditLedger", "authenticated-user"],
  ["getMySubscriptions", "authenticated-user"],
  ["createAdmission", "agent-model-studio-service"],
  ["getAdmission", "agent-model-studio-service"],
  ["captureAdmission", "agent-model-studio-service"],
  ["releaseAdmission", "agent-model-studio-service"],
  ["acceptExecutionEvent", "agent-model-studio-service"],
  ["getExecutionEvent", "agent-model-studio-service"],
  ["createCheckout", "authenticated-user-or-web-bff"],
  ["getCheckout", "authenticated-user-or-web-bff"],
  ["createSettlement", "payment-worker-or-scheduler"],
  ["getSettlement", "payment-worker-or-scheduler"],
  ["createInternalRefund", "payment-worker-service"],
  ["getRefund", "payment-worker-or-billing-admin"],
  ["createAdminRefund", "billing-admin"],
  ["expireCreditHolds", "scheduler-service"],
  ["acceptStripeWebhook", "stripe-signature"],
  ["acceptAlipayWebhook", "alipay-rsa2-form-signature"],
  ["acceptWechatWebhook", "wechatpay-signature"],
]);

const object = (value: unknown): JsonObject | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
const at = (root: JsonObject, pointer: string): unknown =>
  pointer
    .slice(2)
    .split("/")
    .reduce<unknown>(
      (value, part) =>
        object(value)?.[part.replaceAll("~1", "/").replaceAll("~0", "~")],
      root,
    );
const visit = (
  value: unknown,
  callback: (node: JsonObject, path: string) => void,
  path = "$",
): void => {
  if (Array.isArray(value))
    return value.forEach((item, index) =>
      visit(item, callback, `${path}[${index}]`),
    );
  const node = object(value);
  if (!node) return;
  callback(node, path);
  for (const [key, nested] of Object.entries(node))
    visit(nested, callback, `${path}.${key}`);
};
const schemaProperties = (document: JsonObject, name: string): JsonObject =>
  (object(object(object(document.components)?.schemas)?.[name])
    ?.properties as JsonObject) ?? {};

export function validateV2OpenApi(document: unknown): string[] {
  const root = object(document);
  if (!root) return ["document must be an object"];
  const errors: string[] = [];
  if (root.openapi !== "3.1.0") errors.push("openapi must be 3.1.0");
  if (object(root.info)?.version !== "2.0.0")
    errors.push("info.version must be 2.0.0");
  const paths = object(root.paths) ?? {};
  const actual = new Map<string, JsonObject>();
  const ids = new Set<string>();
  for (const [path, itemValue] of Object.entries(paths))
    for (const [method, operationValue] of Object.entries(
      object(itemValue) ?? {},
    )) {
      if (!methods.has(method)) continue;
      const operation = object(operationValue);
      if (!operation) continue;
      const key = `${method} ${path}`;
      actual.set(key, operation);
      const id = operation.operationId;
      if (typeof id !== "string" || id.length === 0)
        errors.push(`${key} missing operationId`);
      else if (ids.has(id)) errors.push(`duplicate operationId ${id}`);
      else ids.add(id);
      for (const [field, expected] of [
        ["x-kokoro-owner", "kokoro-billing"],
        ["x-kokoro-visibility", "internal-owner"],
        ["x-kokoro-stability", "experimental"],
      ] as const)
        if (operation[field] !== expected)
          errors.push(`${key} ${field} must be ${expected}`);
      if (
        typeof id === "string" &&
        operation["x-kokoro-permission"] !==
          expectedPermissionByOperation.get(id)
      )
        errors.push(`${key} has an invalid permission`);
      const responses = object(operation.responses) ?? {};
      for (const [status, responseValue] of Object.entries(responses)) {
        if (!/^[1-5][0-9]{2}$/u.test(status))
          errors.push(`${key} invalid response key ${status}`);
        const response = object(responseValue);
        const headers = object(response?.headers);
        if (!headers?.["x-request-id"])
          errors.push(`${key} ${status} missing x-request-id`);
        if (
          /^[45]/u.test(status) &&
          object(
            object(object(response?.content)?.["application/json"])?.schema,
          )?.$ref === "#/components/schemas/ErrorResponse" &&
          (!Array.isArray(response?.["x-kokoro-errors"]) ||
            response["x-kokoro-errors"].length === 0 ||
            response["x-kokoro-errors"].some((entry) => {
              const error = object(entry);
              return (
                typeof error?.code !== "string" ||
                !/^billing\.[a-z0-9_]+$/u.test(error.code) ||
                typeof error.retryable !== "boolean"
              );
            }))
        )
          errors.push(`${key} ${status} missing explicit error semantics`);
      }
    }
  for (const [key, id] of expectedOperations)
    if (actual.get(key)?.operationId !== id)
      errors.push(`missing ${key} (${id})`);
  for (const key of actual.keys())
    if (!expectedOperations.has(key))
      errors.push(`unexpected operation ${key}`);
  if (actual.size !== 24)
    errors.push(`expected 24 operations, found ${actual.size}`);
  let accepted = 0;
  for (const [key, operation] of actual) {
    const responses = object(operation.responses) ?? {};
    if (responses["202"]) {
      accepted++;
      if (key !== "post /v2/internal/billing/execution-events")
        errors.push(`${key} must not return 202`);
    }
  }
  if (accepted !== 1)
    errors.push("exactly execution event POST must return 202");
  for (const key of [
    "post /v2/internal/billing/admissions",
    "post /v2/internal/billing/execution-events",
    "post /v2/billing/checkouts",
    "post /v2/internal/payment/settlements",
    "post /v2/internal/payment/refunds",
    "post /v2/admin/billing/refunds",
  ]) {
    const status = key.includes("execution-events") ? "202" : "201";
    const response = object(object(actual.get(key)?.responses)?.[status]);
    if (!object(response?.headers)?.Location)
      errors.push(`${key} ${status} missing Location`);
    if (
      object(object(response?.content)?.["application/json"])?.schema ===
      undefined
    )
      errors.push(`${key} ${status} missing success representation`);
  }
  const admissionPost = actual.get("post /v2/internal/billing/admissions");
  if (
    !Array.isArray(admissionPost?.security) ||
    admissionPost.security.length === 0
  )
    errors.push("admission POST requires authenticated service security");
  if (
    !Array.isArray(admissionPost?.parameters) ||
    !admissionPost.parameters.some(
      (parameter) =>
        object(parameter)?.$ref === "#/components/parameters/ConsumptionToken",
    )
  )
    errors.push("admission POST requires ConsumptionToken");
  const expectedSecurity = new Map<string, readonly (readonly string[])[]>([
    [
      "get /v2/commerce/catalog",
      [
        ["tenantContext", "userBearer"],
        ["internalSecret", "serviceBearer", "serviceCaller", "tenantContext"],
      ],
    ],
    ["get /v2/billing/me/credit-account", [["tenantContext", "userBearer"]]],
    ["get /v2/billing/me/credit-ledger", [["tenantContext", "userBearer"]]],
    ["get /v2/billing/me/subscriptions", [["tenantContext", "userBearer"]]],
    [
      "post /v2/billing/checkouts",
      [
        ["tenantContext", "userBearer"],
        [
          "internalSecret",
          "serviceBearer",
          "serviceCaller",
          "subjectContext",
          "tenantContext",
        ],
      ],
    ],
    [
      "get /v2/billing/checkouts/{checkout_id}",
      [
        ["tenantContext", "userBearer"],
        [
          "internalSecret",
          "serviceBearer",
          "serviceCaller",
          "subjectContext",
          "tenantContext",
        ],
      ],
    ],
    [
      "post /v2/admin/billing/refunds",
      [
        [
          "adminRole",
          "adminService",
          "operatorContext",
          "operatorProxySecret",
          "tenantContext",
        ],
      ],
    ],
    [
      "get /v2/internal/payment/refunds/{refund_id}",
      [
        ["internalSecret", "serviceCaller", "tenantContext"],
        [
          "adminRole",
          "adminService",
          "operatorContext",
          "operatorProxySecret",
          "tenantContext",
        ],
      ],
    ],
  ]);
  for (const [key, expected] of expectedSecurity) {
    const security = actual.get(key)?.security;
    const normalized = Array.isArray(security)
      ? security
          .map((item) =>
            Object.keys(object(item) ?? {})
              .sort()
              .join("+"),
          )
          .sort()
      : [];
    const wanted = expected.map((item) => [...item].sort().join("+")).sort();
    if (JSON.stringify(normalized) !== JSON.stringify(wanted))
      errors.push(`${key} has incomplete authentication factors`);
  }
  for (const [key, operation] of actual) {
    const path = key.slice(key.indexOf(" ") + 1);
    const names = [...path.matchAll(/\{([^}]+)\}/gu)].map((match) => match[1]);
    for (const name of names) {
      const parameter = Array.isArray(operation.parameters)
        ? operation.parameters
            .map(object)
            .find((item) => item?.in === "path" && item.name === name)
        : undefined;
      if (object(parameter?.schema)?.$ref !== "#/components/schemas/Uuid")
        errors.push(`${key} path parameter ${name ?? "unknown"} must be UUID`);
    }
  }
  visit(root, (node, path) => {
    if (typeof node.$ref === "string") {
      if (!node.$ref.startsWith("#/"))
        errors.push(`${path} must use a local ref`);
      else if (at(root, node.$ref) === undefined)
        errors.push(`${path} unknown ref ${node.$ref}`);
    }
    if ("request_id" in node || "requestId" in node)
      errors.push(`${path} embeds request id in a body schema`);
    if ("x-kokoro-request-id" in node)
      errors.push(`${path} uses retired request-id header`);
  });
  const admission = schemaProperties(root, "AdmissionCreateRequest");
  if (admission.payer_ref)
    errors.push("AdmissionCreateRequest must not accept payer_ref");
  if (!admission.billing_subject)
    errors.push("AdmissionCreateRequest requires billing_subject attribution");
  const checkout = schemaProperties(root, "CheckoutCreateRequest");
  for (const key of [
    "amount_minor",
    "currency_code",
    "quote_snapshot",
    "quote_snapshot_json",
  ])
    if (checkout[key])
      errors.push(`CheckoutCreateRequest must not accept ${key}`);
  const settlement = schemaProperties(root, "SettlementCreateRequest");
  if (settlement.settlement_id)
    errors.push("SettlementCreateRequest must not accept settlement_id");
  for (const key of [
    "provider",
    "provider_account_id",
    "external_payment_ref",
    "amount_minor",
    "currency_code",
  ])
    if (!settlement[key]) errors.push(`SettlementCreateRequest missing ${key}`);
  const uuidPaths = [
    ["Admission", "admission_id"],
    ["ExecutionEvent", "execution_event_id"],
    ["Checkout", "checkout_id"],
    ["Settlement", "settlement_id"],
    ["Refund", "refund_id"],
  ] as const;
  for (const [schema, property] of uuidPaths)
    if (
      object(schemaProperties(root, schema)[property])?.$ref !==
      "#/components/schemas/Uuid"
    )
      errors.push(`${schema}.${property} must be UUID`);
  const stripe = object(
    object(actual.get("post /v2/webhooks/payment/stripe")?.responses)?.["200"],
  );
  if (!stripe) errors.push("Stripe webhook must define a 200 ACK");
  if (stripe?.content !== undefined)
    errors.push("Stripe ACK must have an empty body");
  const wechat = object(
    object(actual.get("post /v2/webhooks/payment/wechat")?.responses)?.["204"],
  );
  if (wechat?.content !== undefined)
    errors.push("WeChat ACK must have an empty body");
  const alipaySchema = object(
    object(
      object(
        object(
          object(actual.get("post /v2/webhooks/payment/alipay")?.responses)?.[
            "200"
          ],
        )?.content,
      )?.["text/plain"],
    )?.schema,
  );
  if (alipaySchema?.const !== "success")
    errors.push("Alipay ACK must be exact text success");
  for (const name of [
    "AdmissionCreateRequest",
    "AdmissionCaptureRequest",
    "AdmissionReleaseRequest",
    "ExecutionEventRequest",
    "CheckoutCreateRequest",
    "SettlementCreateRequest",
    "RefundCreateRequest",
    "ExpireCreditHoldsRequest",
  ])
    if (
      object(object(object(root.components)?.schemas)?.[name])
        ?.additionalProperties !== false
    )
      errors.push(`${name} must reject unknown fields`);
  const requiredNullable = new Map<string, readonly string[]>([
    ["Admission", ["hold_id", "accepted_provider_ref", "accepted_at"]],
    ["ExecutionEvent", ["dead_lettered_at", "last_error_code", "processed_at"]],
    ["Checkout", ["checkout_url", "provider_session_expires_at"]],
    ["Settlement", ["credit_fulfillment_id", "credit_grant_id"]],
    ["Refund", ["credit_fulfillment_id", "credit_grant_id", "journal_id"]],
  ]);
  for (const [name, fields] of requiredNullable) {
    const schema = object(object(object(root.components)?.schemas)?.[name]);
    const required = Array.isArray(schema?.required) ? schema.required : [];
    const properties = object(schema?.properties) ?? {};
    for (const field of fields) {
      if (!required.includes(field))
        errors.push(`${name}.${field} must be required and nullable`);
      const type = object(properties[field])?.type;
      if (!Array.isArray(type) || !type.includes("null"))
        errors.push(`${name}.${field} must be required and nullable`);
    }
  }
  return errors;
}

export function assertV2OpenApi(document: unknown): void {
  const errors = validateV2OpenApi(document);
  if (errors.length > 0)
    throw new Error(`v2 target OpenAPI invalid:\n- ${errors.join("\n- ")}`);
}
