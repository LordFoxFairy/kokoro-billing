import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse } from 'yaml';

type OpenApiDocument = { readonly openapi?: string; readonly paths?: Record<string, Record<string, unknown>> };

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
const contract = parse(await readFile(resolve(root, 'contract/openapi/v1/openapi.yaml'), 'utf8')) as OpenApiDocument;
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
const tenantContext = (contract as { readonly components?: { readonly securitySchemes?: Record<string, { readonly name?: string }> } }).components?.securitySchemes?.tenantContext;
if (tenantContext?.name !== 'X-Kokoro-Tenant-Id') throw new Error('external OpenAPI contract must expose X-Kokoro-Tenant-Id as tenant context');

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
    if (/^(get|post|put|patch|delete|options|head)$/u.test(method)) documented.add(`${method} ${path}`);
  }
}

const missing = [...implementation].filter((route) => !documented.has(route)).sort();
const stale = [...documented].filter((route) => !implementation.has(route)).sort();
if (missing.length > 0 || stale.length > 0) {
  throw new Error(JSON.stringify({ missing, stale }, null, 2));
}
console.log(`OpenAPI route parity passed: ${implementation.size} routes`);
