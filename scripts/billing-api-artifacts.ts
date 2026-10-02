import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import ts from "typescript";
import { parse } from "yaml";
import { assertV2OpenApi } from "./openapi-v2-target.js";

export const billingApiOfficialNames = [
  "index.ts",
  "types.gen.ts",
  "schemas.gen.ts",
] as const;
export const billingApiArtifactNames = [
  ...billingApiOfficialNames,
  "provenance.json",
] as const;
export const billingApiGenerator = {
  package: "@hey-api/openapi-ts",
  version: "0.99.0",
  plugins: [
    { name: "@hey-api/typescript" },
    { name: "@hey-api/schemas", type: "json" },
  ],
  import_file_extension: ".js",
  formatter: {
    package: "prettier",
    version: "3.9.6",
    config: ".prettierrc.json",
    ignore_path: ".prettierignore",
    editorconfig: false,
  },
  typescript_version: "6.0.3",
} as const;

// This is the closed source-component/export binding set, not another schema.
const componentNames = [
  "Uuid",
  "UtcInstant",
  "DecimalInteger",
  "NonNegativeDecimal",
  "PositiveDecimal",
  "CreditMicros",
  "NonNegativeCreditMicros",
  "CurrencyCode",
  "ErrorResponse",
  "HealthResponse",
  "ReadyResponse",
  "Page",
  "BillingSubject",
  "CatalogItem",
  "CatalogResponse",
  "CreditAccount",
  "CreditAccountResponse",
  "LedgerEntry",
  "CreditLedgerResponse",
  "Subscription",
  "SubscriptionsResponse",
  "AdmissionCreateRequest",
  "AdmissionCaptureRequest",
  "AdmissionReleaseRequest",
  "Admission",
  "AdmissionResponse",
  "ExecutionEventRequest",
  "ExecutionEvent",
  "ExecutionEventResponse",
  "CheckoutCreateRequest",
  "Checkout",
  "CheckoutResponse",
  "SettlementCreateRequest",
  "Settlement",
  "SettlementResponse",
  "RefundCreateRequest",
  "Refund",
  "RefundResponse",
  "ExpireCreditHoldsRequest",
  "ExpireCreditHoldsResult",
  "ExpireCreditHoldsResponse",
  "ProviderJsonPayload",
  "AlipayWebhookForm",
] as const;

type ArtifactInput = Readonly<{
  sourceText: string;
  officialFiles: Readonly<Record<string, string>>;
}>;

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Billing API artifact expected an object");
  }
  return value as Record<string, unknown>;
}

function assertKeys(
  value: object,
  names: readonly string[],
  label: string,
): void {
  if (!isDeepStrictEqual(Object.keys(value).sort(), [...names].sort())) {
    throw new Error("Billing API " + label + " closed set mismatch");
  }
}

function assertSchemaRefs(value: unknown, names: readonly string[]): void {
  if (Array.isArray(value)) {
    for (const child of value) assertSchemaRefs(child, names);
  } else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(object(value))) {
      if (
        key === "$ref" &&
        (typeof child !== "string" ||
          !names.some((name) => child === "#/components/schemas/" + name))
      ) {
        throw new Error("Billing API unknown schema ref: " + String(child));
      }
      assertSchemaRefs(child, names);
    }
  }
}

export function readBillingApiSource(
  sourceText: string,
): Record<string, unknown> {
  const document = object(parse(sourceText) as unknown);
  assertV2OpenApi(document);
  const schemas = object(object(document.components).schemas);
  assertKeys(schemas, componentNames, "source components");
  assertSchemaRefs(schemas, componentNames);
  return document;
}

// Parse only JSON literal AST nodes. Never execute a generated module to verify it.
function literal(node: ts.Expression): unknown {
  if (ts.isAsExpression(node)) {
    if (
      !ts.isTypeReferenceNode(node.type) ||
      node.type.typeName.getText() !== "const"
    ) {
      throw new Error("Billing API schema has a non-const assertion");
    }
    return literal(node.expression);
  }
  if (ts.isStringLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(node.operand)
  )
    return -Number(node.operand.text);
  if (ts.isArrayLiteralExpression(node)) return node.elements.map(literal);
  if (ts.isObjectLiteralExpression(node)) {
    const entries: [string, unknown][] = [];
    for (const property of node.properties) {
      if (
        !ts.isPropertyAssignment(property) ||
        !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
      ) {
        throw new Error("Billing API schema has a non-literal property");
      }
      const name = property.name.text;
      if (entries.some(([key]) => key === name))
        throw new Error("Billing API duplicate schema property");
      entries.push([name, literal(property.initializer)]);
    }
    return Object.fromEntries(entries);
  }
  throw new Error(
    "Billing API schema has an executable or unsupported expression",
  );
}

function schemaExports(source: string): Record<string, unknown> {
  const syntax = ts.transpileModule(source, { reportDiagnostics: true });
  if (
    syntax.diagnostics?.some((d) => d.category === ts.DiagnosticCategory.Error)
  ) {
    throw new Error("Billing API schema module has syntax errors");
  }
  const module = ts.createSourceFile(
    "schemas.gen.ts",
    source,
    ts.ScriptTarget.ES2022,
    true,
  );
  const entries: [string, unknown][] = [];
  for (const statement of module.statements) {
    if (
      !ts.isVariableStatement(statement) ||
      statement.modifiers?.length !== 1 ||
      statement.modifiers[0]?.kind !== ts.SyntaxKind.ExportKeyword ||
      !(statement.declarationList.flags & ts.NodeFlags.Const) ||
      statement.declarationList.declarations.length !== 1
    ) {
      throw new Error("Billing API unexpected schema export statement");
    }
    const declaration = statement.declarationList.declarations[0];
    if (
      !declaration ||
      !ts.isIdentifier(declaration.name) ||
      !declaration.initializer
    ) {
      throw new Error("Billing API missing schema export initializer");
    }
    const name = declaration.name.text;
    if (entries.some(([key]) => key === name))
      throw new Error("Billing API duplicate schema export");
    entries.push([name, literal(declaration.initializer)]);
  }
  return Object.fromEntries(entries);
}

function fingerprint(
  text: string,
): Readonly<{ bytes: number; sha256: string }> {
  return {
    bytes: Buffer.byteLength(text, "utf8"),
    sha256: createHash("sha256").update(text, "utf8").digest("hex"),
  };
}

export function createBillingApiProvenance(input: ArtifactInput) {
  const document = readBillingApiSource(input.sourceText);
  const schemas = object(object(document.components).schemas);
  assertKeys(
    input.officialFiles,
    billingApiOfficialNames,
    "official output files",
  );
  const exports = schemaExports(input.officialFiles["schemas.gen.ts"] ?? "");
  const bindings = Object.fromEntries(
    [...componentNames].sort().map((name) => [name, name + "Schema"]),
  );
  assertKeys(exports, Object.values(bindings), "schema exports");
  assertSchemaRefs(exports, componentNames);
  for (const [component, binding] of Object.entries(bindings)) {
    if (!isDeepStrictEqual(schemas[component], exports[binding])) {
      throw new Error("Billing API schema semantic drift: " + component);
    }
  }
  return {
    owner: "@kokoro/billing",
    source: {
      path: "contract/openapi/v2/openapi.yaml",
      version: object(document.info).version,
      ...fingerprint(input.sourceText),
    },
    generator: billingApiGenerator,
    schema_bindings: bindings,
    outputs: Object.fromEntries(
      billingApiOfficialNames.map((name) => [
        name,
        fingerprint(input.officialFiles[name] ?? ""),
      ]),
    ),
  };
}

export function assertBillingApiProvenance(
  input: ArtifactInput & Readonly<{ provenance: unknown }>,
): void {
  if (!isDeepStrictEqual(input.provenance, createBillingApiProvenance(input))) {
    throw new Error("Billing API provenance drift");
  }
}

export function assertBillingApiArtifactBytes(
  actual: Readonly<Record<string, string>>,
  expected: Readonly<Record<string, string>>,
): void {
  assertKeys(actual, billingApiArtifactNames, "artifact files");
  assertKeys(expected, billingApiArtifactNames, "expected artifact files");
  for (const name of billingApiArtifactNames) {
    if (actual[name] !== expected[name]) {
      throw new Error("Billing API artifact byte drift: " + name);
    }
  }
}
