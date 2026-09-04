import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { z } from 'zod';

const recordSchema = z.record(z.string(), z.unknown());
const openApiSchema = z.object({
  paths: z.record(z.string(), recordSchema),
  components: z.object({
    securitySchemes: recordSchema,
    requestBodies: recordSchema,
    schemas: recordSchema,
  }),
}).passthrough();

const readContract = async () => openApiSchema.parse(parse(await readFile(
  join(process.cwd(), 'contract/openapi/v1/openapi.yaml'),
  'utf8',
)));

const operation = (document: z.infer<typeof openApiSchema>, path: string): Record<string, unknown> => {
  const pathItem = document.paths[path];
  return recordSchema.parse(pathItem?.post);
};

describe('Billing command OpenAPI contract', () => {
  it('defines exact request bodies for durable settlement and expiry commands', async () => {
    const document = await readContract();
    expect(operation(document, '/v1/internal/payment/settlements/accept').requestBody).toEqual({
      $ref: '#/components/requestBodies/V1SettlementAcceptRequest',
    });
    expect(operation(document, '/v1/internal/commands/expire-credit-holds').requestBody).toEqual({
      $ref: '#/components/requestBodies/V1ExpireCreditHoldsRequest',
    });

    const settlement = recordSchema.parse(document.components.schemas.V1SettlementAcceptRequest);
    expect(settlement.required).toEqual([
      'settlement_id',
      'provider',
      'external_payment_ref',
      'amount_minor',
      'currency',
    ]);
    expect(settlement.additionalProperties).toBe(false);
    const settlementProperties = recordSchema.parse(settlement.properties);
    expect(recordSchema.parse(settlementProperties.provider).enum).toEqual(['stripe', 'alipay', 'wechat']);

    const expiry = recordSchema.parse(document.components.schemas.V1ExpireCreditHoldsRequest);
    expect(expiry.required).toEqual(['batch_id']);
    expect(expiry.additionalProperties).toBe(false);
  });
});
