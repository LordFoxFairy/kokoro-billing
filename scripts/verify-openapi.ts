import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from 'yaml';

type OpenApiDocument = {
  readonly openapi?: string;
  readonly paths?: Record<string, Record<string, unknown>>;
  readonly components?: { readonly schemas?: Record<string, unknown> };
};
type OperationGovernance = Readonly<{ idempotency: string; permission: string }>;

const expectedOperationGovernance: Readonly<Record<string, OperationGovernance>> = {
  'get /healthz': { idempotency: 'inherent', permission: 'none' },
  'get /readyz': { idempotency: 'inherent', permission: 'none' },
  'get /metrics': { idempotency: 'inherent', permission: 'none' },
  'get /v1/commerce/catalog': { idempotency: 'read-only', permission: 'authenticated-user-or-web-bff' },
  'get /v1/billing/me/credit-account': { idempotency: 'read-only', permission: 'authenticated-user' },
  'get /v1/billing/me/credit-ledger': { idempotency: 'read-only', permission: 'authenticated-user' },
  'post /v1/internal/entitlement/admissions': { idempotency: 'required', permission: 'agent-model-studio-service' },
  'post /v1/internal/entitlement/admissions/{admissionId}/capture': { idempotency: 'required', permission: 'agent-model-studio-service' },
  'post /v1/internal/entitlement/admissions/{admissionId}/release': { idempotency: 'required', permission: 'agent-model-studio-service' },
  'post /v1/internal/billing/execution-events': { idempotency: 'required', permission: 'agent-model-studio-service' },
  'post /v1/internal/payment/settlements/accept': { idempotency: 'required', permission: 'payment-worker-or-scheduler' },
  'post /v1/internal/payment/refunds/accept': { idempotency: 'required', permission: 'payment-worker-service' },
  'post /v1/internal/commands/expire-credit-holds': { idempotency: 'required', permission: 'scheduler-service' },
  'post /v1/webhooks/payment/{provider}': { idempotency: 'provider-event-id', permission: 'provider-signature' },
  'get /v1/billing/me/subscriptions': { idempotency: 'read-only', permission: 'authenticated-user' },
  'post /v1/billing/checkout': { idempotency: 'required', permission: 'authenticated-user-or-web-bff' },
  'post /v1/admin/billing/refunds': { idempotency: 'required', permission: 'billing-admin' },
};

const httpMethod = /^(get|post|put|patch|delete|options|head)$/u;
const asRecord = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.entries(value))
  : null;

const keysNamed = (value: unknown, target: string, path = '$'): string[] => {
  if (Array.isArray(value)) return value.flatMap((item, index) => keysNamed(item, target, `${path}[${index}]`));
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, nested]) => [
    ...(key === target ? [`${path}.${key}`] : []),
    ...keysNamed(nested, target, `${path}.${key}`),
  ]);
};

const root = resolve(new URL('..', import.meta.url).pathname);
const serverSource = await readFile(resolve(root, 'src/interfaces/http/server.ts'), 'utf8');
const contractSource = await readFile(resolve(root, 'contract/openapi/v1/openapi.yaml'), 'utf8');
const contractReadme = await readFile(resolve(root, 'contract/README.md'), 'utf8');
const contractDigest = createHash('sha256').update(contractSource).digest('hex');
if (!contractReadme.includes(contractDigest)) throw new Error(`contract/README.md provenance digest must be ${contractDigest}`);
const contract = parse(contractSource) as OpenApiDocument;
if (contract.openapi !== '3.0.3') throw new Error(`unsupported OpenAPI version: ${contract.openapi ?? 'missing'}`);
const externalSiteIdProperties = keysNamed(contract, 'tenantId');
if (externalSiteIdProperties.length > 0) {
  throw new Error(`external OpenAPI contract must not expose tenantId properties: ${externalSiteIdProperties.join(', ')}`);
}
const camelCaseRequestIds = keysNamed(contract, 'requestId');
if (camelCaseRequestIds.length > 0) {
  throw new Error(`OpenAPI contract must use meta.request_id instead of requestId: ${camelCaseRequestIds.join(', ')}`);
}
const v1Error = (contract as { readonly components?: { readonly schemas?: { readonly V1ErrorResponse?: { readonly properties?: { readonly error?: { readonly properties?: Record<string, unknown> } } } } } }).components?.schemas?.V1ErrorResponse;
if (v1Error?.properties?.error?.properties?.request_id !== undefined) {
  throw new Error('OpenAPI error.request_id is forbidden; request_id belongs only in meta');
}
const executionEventSchema = (contract as { readonly components?: { readonly schemas?: { readonly V1ExecutionEventRequest?: unknown } } }).components?.schemas?.V1ExecutionEventRequest;
if (executionEventSchema === undefined) throw new Error('OpenAPI must define V1ExecutionEventRequest');
const retiredExecutionSignatures = keysNamed(executionEventSchema, 'signature');
if (retiredExecutionSignatures.length > 0) {
  throw new Error(`trusted execution events must not expose an unverified signature field: ${retiredExecutionSignatures.join(', ')}`);
}
const executionEventPost = contract.paths?.['/v1/internal/billing/execution-events']?.post;
const executionEventRequestBody = executionEventPost !== null && typeof executionEventPost === 'object' && 'requestBody' in executionEventPost
  ? executionEventPost.requestBody
  : undefined;
if (executionEventRequestBody === undefined) throw new Error('execution-events must reference its OpenAPI request body');
const requiredCommandBodies: Readonly<Record<string, string>> = {
  '/v1/internal/payment/settlements/accept': '#/components/requestBodies/V1SettlementAcceptRequest',
  '/v1/internal/commands/expire-credit-holds': '#/components/requestBodies/V1ExpireCreditHoldsRequest',
};
for (const [path, expectedRef] of Object.entries(requiredCommandBodies)) {
  const post = asRecord(contract.paths?.[path]?.post);
  const requestBody = asRecord(post?.requestBody);
  if (requestBody?.$ref !== expectedRef) throw new Error(`${path} must reference ${expectedRef}`);
}
const settlementSchema = asRecord(contract.components?.schemas?.V1SettlementAcceptRequest);
const settlementProperties = asRecord(settlementSchema?.properties);
const settlementProvider = asRecord(settlementProperties?.provider);
if (JSON.stringify(settlementSchema?.required) !== JSON.stringify(['settlement_id', 'provider', 'external_payment_ref', 'amount_minor', 'currency'])
  || settlementSchema?.additionalProperties !== false
  || JSON.stringify(settlementProvider?.enum) !== JSON.stringify(['stripe', 'alipay', 'wechat'])) {
  throw new Error('V1SettlementAcceptRequest must define the exact durable command payload and provider enum');
}
const expirySchema = asRecord(contract.components?.schemas?.V1ExpireCreditHoldsRequest);
if (JSON.stringify(expirySchema?.required) !== JSON.stringify(['batch_id']) || expirySchema?.additionalProperties !== false) {
  throw new Error('V1ExpireCreditHoldsRequest must require only the explicit batch identity');
}
const tenantContext = (contract as { readonly components?: { readonly securitySchemes?: Record<string, { readonly name?: string }> } }).components?.securitySchemes?.tenantContext;
if (tenantContext?.name !== 'X-Kokoro-Tenant-Id') throw new Error('external OpenAPI contract must expose X-Kokoro-Tenant-Id as tenant context');

const governanceErrors: string[] = [];
const governedOperations = new Set<string>();
for (const [path, methods] of Object.entries(contract.paths ?? {})) {
  for (const [method, rawOperation] of Object.entries(methods)) {
    if (!httpMethod.test(method)) continue;
    const operationKey = `${method} ${path}`;
    const expected = expectedOperationGovernance[operationKey];
    if (expected === undefined) {
      governanceErrors.push(`${operationKey}: governance expectation is missing`);
      continue;
    }
    governedOperations.add(operationKey);
    if (rawOperation === null || typeof rawOperation !== 'object' || Array.isArray(rawOperation)) {
      governanceErrors.push(`${operationKey}: operation must be an object`);
      continue;
    }
    const operation = rawOperation;
    const expectedMetadata: Readonly<Record<string, string>> = {
      'x-kokoro-owner': 'kokoro-billing',
      'x-kokoro-visibility': 'internal-owner',
      'x-kokoro-stability': 'stable',
      'x-kokoro-idempotency': expected.idempotency,
      'x-kokoro-permission': expected.permission,
    };
    for (const [field, value] of Object.entries(expectedMetadata)) {
      if (Reflect.get(operation, field) !== value) governanceErrors.push(`${operationKey}: ${field} must be ${JSON.stringify(value)}`);
    }
  }
}
for (const operationKey of Object.keys(expectedOperationGovernance)) {
  if (!governedOperations.has(operationKey)) governanceErrors.push(`${operationKey}: documented operation is missing`);
}
if (governanceErrors.length > 0) throw new Error(`OpenAPI governance failed:\n${governanceErrors.join('\n')}`);

const implementation = new Set<string>();
const routePattern = /app\.(get|post|put|patch|delete|options|head)(?:<[^>]+>)?\(['"]([^'"]+)['"]/gu;
for (const match of serverSource.matchAll(routePattern)) {
  const method = match[1]?.toLowerCase();
  const rawPath = match[2];
  if (!method || !rawPath) continue;
  implementation.add(`${method} ${rawPath.replace(/:([A-Za-z0-9_]+)/gu, '{$1}')}`);
}
// `/metrics` is registered by the shared Prometheus helper rather than an
// inline `app.get` declaration, so include that framework-owned route here.
implementation.add('get /metrics');

const documented = new Set<string>();
for (const [path, methods] of Object.entries(contract.paths ?? {})) {
  for (const method of Object.keys(methods)) {
    if (httpMethod.test(method)) documented.add(`${method} ${path}`);
  }
}

const missing = [...implementation].filter((route) => !documented.has(route)).sort();
const stale = [...documented].filter((route) => !implementation.has(route)).sort();
if (missing.length > 0 || stale.length > 0) {
  throw new Error(JSON.stringify({ missing, stale }, null, 2));
}
console.log(`OpenAPI governance and route parity passed: ${implementation.size} routes`);
