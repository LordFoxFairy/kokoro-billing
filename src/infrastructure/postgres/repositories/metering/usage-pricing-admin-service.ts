import { createHash, randomUUID } from "node:crypto";
import type {
  SqlConnection,
  ResultSetHeader,
  RowDataPacket,
} from "../../database.js";
import { z } from "zod";
import { parsePersistedJson, PersistedDataInvariantError } from "../../json.js";

export type UsagePriceRateInput = {
  readonly featureKey: string;
  readonly labelKey?: string | null;
  readonly modelBindingId?: string | null;
  readonly inputMicrosPerMillion: number;
  readonly outputMicrosPerMillion: number;
  /** Reserved in the schema; V1 runtime usage does not yet report cached tokens. */
  readonly cachedMicrosPerMillion?: number;
  readonly reservationMicros: number;
};

export type PublishUsagePricingInput = {
  readonly tenantId: string;
  readonly operatorId: string;
  readonly effectiveFrom: Date;
  readonly rates: readonly UsagePriceRateInput[];
  readonly reason: string;
  readonly idempotencyKey: string;
};

export type PublishedUsagePricing = {
  readonly pricingRevisionId: string;
  readonly revision: number;
  readonly effectiveFrom: string;
  readonly rates: readonly UsagePriceRateInput[];
};

const usagePriceRateSchema = z
  .object({
    featureKey: z.string().min(1),
    labelKey: z.string().nullable().optional(),
    modelBindingId: z.string().nullable().optional(),
    inputMicrosPerMillion: z.number().int().nonnegative(),
    outputMicrosPerMillion: z.number().int().nonnegative(),
    cachedMicrosPerMillion: z.number().int().nonnegative().optional(),
    reservationMicros: z.number().int().positive(),
  })
  .strict();
const publishedUsagePricingSchema = z
  .object({
    pricingRevisionId: z.string().min(1),
    revision: z.number().int().positive(),
    effectiveFrom: z.string().datetime({ offset: true }),
    rates: z.array(usagePriceRateSchema),
  })
  .strict();

const parsePublishedUsagePricing = (value: unknown): PublishedUsagePricing => {
  const parsed = parsePersistedJson(
    value,
    publishedUsagePricingSchema,
    "billing.command_result_invalid",
  );
  return {
    pricingRevisionId: parsed.pricingRevisionId,
    revision: parsed.revision,
    effectiveFrom: parsed.effectiveFrom,
    rates: parsed.rates.map((rate) => ({
      featureKey: rate.featureKey,
      ...(rate.labelKey === undefined ? {} : { labelKey: rate.labelKey }),
      ...(rate.modelBindingId === undefined
        ? {}
        : { modelBindingId: rate.modelBindingId }),
      inputMicrosPerMillion: rate.inputMicrosPerMillion,
      outputMicrosPerMillion: rate.outputMicrosPerMillion,
      ...(rate.cachedMicrosPerMillion === undefined
        ? {}
        : { cachedMicrosPerMillion: rate.cachedMicrosPerMillion }),
      reservationMicros: rate.reservationMicros,
    })),
  };
};

const identity = (rate: UsagePriceRateInput): string =>
  `${rate.featureKey}\u0000${rate.labelKey ?? ""}`;

/** Admin-owned immutable usage price revision publisher. */
export class UsagePricingAdminService {
  public constructor(private readonly connection: SqlConnection) {}

  public async publish(
    input: PublishUsagePricingInput,
  ): Promise<PublishedUsagePricing> {
    if (input.rates.length === 0)
      throw new Error("billing.usage_price_rates_required");
    if (
      input.rates.some((rate) =>
        [
          rate.inputMicrosPerMillion,
          rate.outputMicrosPerMillion,
          rate.cachedMicrosPerMillion ?? 0,
          rate.reservationMicros,
        ].some((value) => !Number.isSafeInteger(value) || value < 0),
      )
    )
      throw new Error("billing.usage_price_invalid");
    if (
      input.rates.some(
        (rate) => rate.reservationMicros <= 0 || rate.featureKey.trim() === "",
      )
    )
      throw new Error("billing.usage_price_invalid");
    const identities = new Set(input.rates.map(identity));
    if (identities.size !== input.rates.length)
      throw new Error("billing.usage_price_duplicate_rate");
    const payloadHash = createHash("sha256")
      .update(
        JSON.stringify({
          ...input,
          effectiveFrom: input.effectiveFrom.toISOString(),
          idempotencyKey: undefined,
        }),
      )
      .digest("hex");

    await this.connection.beginTransaction();
    try {
      const [receiptInsert] = await this.connection.execute<ResultSetHeader>(
        `INSERT INTO entitlement_command_receipt (receipt_id, tenant_id, command_name, idempotency_key, payload_hash, status)
         VALUES ($1, $2, 'usage.pricing.publish', $3, $4, 'processing')
         ON CONFLICT DO NOTHING`,
        [randomUUID(), input.tenantId, input.idempotencyKey, payloadHash],
      );
      const [receipts] = await this.connection.execute<RowDataPacket[]>(
        `SELECT payload_hash, status, result_json FROM entitlement_command_receipt
          WHERE tenant_id = $1 AND command_name = 'usage.pricing.publish' AND idempotency_key = $2 FOR UPDATE`,
        [input.tenantId, input.idempotencyKey],
      );
      const receipt = receipts[0] as
        | { payload_hash: string; status: string; result_json: string | null }
        | undefined;
      if (!receipt)
        throw new PersistedDataInvariantError(
          "billing.command_receipt_not_found_after_insert",
        );
      if (receipt.payload_hash !== payloadHash)
        throw new Error("billing.idempotency_conflict");
      if (receipt.status === "succeeded") {
        const replay = parsePublishedUsagePricing(receipt.result_json);
        await this.connection.commit();
        return replay;
      }
      if (receiptInsert.affectedRows !== 1 && receipt.status === "processing")
        throw new Error("billing.command_unknown");
      if (receipt.status === "unknown")
        throw new Error("billing.command_unknown");
      if (receipt.status === "failed")
        throw new Error("billing.command_failed");
      if (receipt.status !== "processing")
        throw new Error("billing.command_unknown");

      const [settings] = await this.connection.query<
        { lock_timeout: string }[]
      >("SELECT pg_catalog.current_setting('lock_timeout') AS lock_timeout");
      const originalLockTimeout = settings[0]?.lock_timeout;
      if (originalLockTimeout === undefined)
        throw new PersistedDataInvariantError("billing.lock_timeout_not_found");
      // Bound only this tenant lock wait; preserve tighter caller budgets.
      await this.connection.query(
        `SELECT pg_catalog.set_config('lock_timeout',
          CASE WHEN $1::text::interval = INTERVAL '0 seconds'
                 OR $1::text::interval > INTERVAL '1 second'
               THEN '1000ms' ELSE $1::text END, true)`,
        [originalLockTimeout],
      );
      await this.connection.query(
        "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('kokoro-billing:usage-pricing:' || $1, 0))",
        [input.tenantId],
      );
      await this.connection.query(
        "SELECT pg_catalog.set_config('lock_timeout', $1, true)",
        [originalLockTimeout],
      );
      // A separate READ COMMITTED statement sees the preceding publisher's commit.
      const [revisions] = await this.connection.execute<RowDataPacket[]>(
        `SELECT COALESCE(MAX(revision), 0) AS revision FROM entitlement_usage_price_revision WHERE tenant_id = $1`,
        [input.tenantId],
      );
      const revision =
        Number(
          (revisions[0] as { revision: number } | undefined)?.revision ?? 0,
        ) + 1;
      const pricingRevisionId = randomUUID();
      const result: PublishedUsagePricing = {
        pricingRevisionId,
        revision,
        effectiveFrom: input.effectiveFrom.toISOString(),
        rates: input.rates,
      };
      await this.connection.execute(
        `INSERT INTO entitlement_usage_price_revision
          (usage_price_revision_id, tenant_id, revision, effective_from, status, published_at)
         VALUES ($1, $2, $3, $4, 'published', CURRENT_TIMESTAMP(3))`,
        [pricingRevisionId, input.tenantId, revision, input.effectiveFrom],
      );
      for (const rate of input.rates) {
        await this.connection.execute(
          `INSERT INTO entitlement_usage_price_rate
            (usage_price_rate_id, usage_price_revision_id, tenant_id, feature_key, label_key, model_binding_id,
             input_micros_per_million, output_micros_per_million, cached_micros_per_million, reservation_micros, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'active')`,
          [
            randomUUID(),
            pricingRevisionId,
            input.tenantId,
            rate.featureKey,
            rate.labelKey ?? null,
            rate.modelBindingId ?? null,
            rate.inputMicrosPerMillion,
            rate.outputMicrosPerMillion,
            rate.cachedMicrosPerMillion ?? 0,
            rate.reservationMicros,
          ],
        );
      }
      await this.connection.execute(
        `UPDATE entitlement_command_receipt SET status = 'succeeded', result_json = $1
          WHERE tenant_id = $2 AND command_name = 'usage.pricing.publish' AND idempotency_key = $3`,
        [JSON.stringify(result), input.tenantId, input.idempotencyKey],
      );
      await this.connection.execute(
        `INSERT INTO entitlement_audit_event
          (audit_event_id, tenant_id, operator_id, action, resource_type, resource_id, reason, payload_json)
         VALUES ($1, $2, $3, 'usage.pricing.publish', 'usage_price_revision', $4, $5, $6)`,
        [
          randomUUID(),
          input.tenantId,
          input.operatorId,
          pricingRevisionId,
          input.reason,
          JSON.stringify({ revision, rateCount: input.rates.length }),
        ],
      );
      await this.connection.commit();
      return result;
    } catch (error) {
      await this.connection.rollback();
      throw error;
    }
  }
}
