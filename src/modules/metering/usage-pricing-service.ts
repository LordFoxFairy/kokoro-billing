import type { Connection, RowDataPacket } from '../../../src/infrastructure/postgres/connection.js';
import { readSafeInteger } from '../../infrastructure/postgres/safe-integer.js';

export type UsageQuote = {
  readonly featureKey: string;
  readonly labelKey: string | null;
  readonly pricingRevisionId: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly amountMicros: number;
  readonly reservationMicros: number;
};

export type UsagePriceRate = {
  readonly featureKey: string;
  readonly labelKey: string | null;
  readonly modelBindingId: string | null;
  readonly pricingRevisionId: string;
  readonly inputMicrosPerMillion: string;
  readonly outputMicrosPerMillion: string;
  readonly reservationMicros: string;
};

type RateRow = RowDataPacket & {
  usage_price_revision_id: string;
  label_key: string | null;
  input_micros_per_million: string | number;
  output_micros_per_million: string | number;
  reservation_micros: string | number;
};

export class UsagePricingService {
  public constructor(private readonly connection: Connection) {}

  public async listActive(siteId: string): Promise<UsagePriceRate[]> {
    const [rows] = await this.connection.execute<(RateRow & { feature_key: string; model_binding_id: string | null })[]>(
      `SELECT r.feature_key, r.label_key, r.model_binding_id, r.usage_price_revision_id,
              r.input_micros_per_million, r.output_micros_per_million, r.reservation_micros
         FROM entitlement_usage_price_rate r
         INNER JOIN entitlement_usage_price_revision p
           ON p.usage_price_revision_id = r.usage_price_revision_id AND p.tenant_id = r.tenant_id
        WHERE r.tenant_id = $1 AND r.status = 'active' AND p.status = 'published'
          AND p.effective_from <= CURRENT_TIMESTAMP(6)
          AND (p.effective_to IS NULL OR p.effective_to > CURRENT_TIMESTAMP(6))
        ORDER BY r.feature_key, r.label_key, r.model_binding_id, p.revision DESC, r.usage_price_rate_id DESC`,
      [siteId],
    );
    return rows.map((row) => ({ featureKey: row.feature_key, labelKey: row.label_key, modelBindingId: row.model_binding_id, pricingRevisionId: row.usage_price_revision_id, inputMicrosPerMillion: String(row.input_micros_per_million), outputMicrosPerMillion: String(row.output_micros_per_million), reservationMicros: String(row.reservation_micros) }));
  }

  public async quote(input: { siteId: string; featureKey: string; labelKey: string | null; inputTokens?: number; outputTokens?: number }): Promise<UsageQuote> {
    const inputTokens = input.inputTokens ?? 0;
    const outputTokens = input.outputTokens ?? 0;
    if (!Number.isSafeInteger(inputTokens) || inputTokens < 0 || !Number.isSafeInteger(outputTokens) || outputTokens < 0) throw new RangeError('token counts must be non-negative safe integers');
    const [rows] = await this.connection.execute<RateRow[]>(
      `SELECT r.usage_price_revision_id, r.label_key, r.input_micros_per_million,
              r.output_micros_per_million, r.reservation_micros
         FROM entitlement_usage_price_rate r
         INNER JOIN entitlement_usage_price_revision p
           ON p.usage_price_revision_id = r.usage_price_revision_id AND p.tenant_id = r.tenant_id
        WHERE r.tenant_id = $1 AND r.feature_key = $2 AND (r.label_key IS NOT DISTINCT FROM $3)
          AND r.status = 'active' AND p.status = 'published'
          AND p.effective_from <= CURRENT_TIMESTAMP(6)
          AND (p.effective_to IS NULL OR p.effective_to > CURRENT_TIMESTAMP(6))
        ORDER BY p.revision DESC, r.usage_price_rate_id DESC LIMIT 1`,
      [input.siteId, input.featureKey, input.labelKey],
    );
    const rate = rows[0];
    if (!rate) throw new Error('billing.usage_price_not_found');
    return this.toQuote(input.featureKey, rate, inputTokens, outputTokens);
  }

  public async quoteForHold(input: { siteId: string; holdId: string; inputTokens?: number; outputTokens?: number }): Promise<UsageQuote> {
    const inputTokens = input.inputTokens ?? 0;
    const outputTokens = input.outputTokens ?? 0;
    if (!Number.isSafeInteger(inputTokens) || inputTokens < 0 || !Number.isSafeInteger(outputTokens) || outputTokens < 0) throw new RangeError('token counts must be non-negative safe integers');
    const [rows] = await this.connection.execute<RateRow[]>(
      `SELECT h.feature_key, h.label_key, h.pricing_revision_id AS usage_price_revision_id,
              r.input_micros_per_million, r.output_micros_per_million, r.reservation_micros
         FROM entitlement_credit_hold h
         INNER JOIN entitlement_usage_price_rate r
           ON r.usage_price_revision_id = h.pricing_revision_id
          AND r.tenant_id = h.tenant_id AND r.feature_key = h.feature_key
          AND (r.label_key IS NOT DISTINCT FROM h.label_key) AND r.status = 'active'
        WHERE h.tenant_id = $1 AND h.credit_hold_id = $2 LIMIT 1`,
      [input.siteId, input.holdId],
    );
    const rate = rows[0] as (RateRow & { feature_key: string }) | undefined;
    if (!rate) throw new Error('billing.usage_price_not_found');
    return this.toQuote(rate.feature_key, rate, inputTokens, outputTokens);
  }

  private toQuote(featureKey: string, rate: RateRow, inputTokens: number, outputTokens: number): UsageQuote {
    const rawAmount = BigInt(rate.input_micros_per_million) * BigInt(inputTokens)
      + BigInt(rate.output_micros_per_million) * BigInt(outputTokens);
    // Charge one micros unit for any non-zero fractional result. Flooring would
    // create a systematic undercharge for token counts below one million.
    const amount = (rawAmount + 999_999n) / 1_000_000n;
    const amountNumber = Number(amount);
    const reservationMicros = readSafeInteger(rate.reservation_micros, 'reservation_micros');
    if (!Number.isSafeInteger(amountNumber) || !Number.isSafeInteger(reservationMicros)) throw new Error('billing.usage_amount_overflow');
    return { featureKey, labelKey: rate.label_key, pricingRevisionId: rate.usage_price_revision_id, inputTokens, outputTokens, amountMicros: amountNumber, reservationMicros };
  }
}
