import { randomUUID } from "node:crypto";
import type { TransactionService } from "../../database/transaction.service.js";
import { toPersistedJson } from "../../database/persisted-json.js";
import { commandDigest } from "../../database/canonical-digest.js";
import { MeteringError } from "./metering.error.js";
import type {
  PriceQuote,
  QuoteInput,
  RecordUsageInput,
} from "./metering.types.js";

export class MeteringRepository {
  constructor(private readonly transactions: TransactionService) {}
  async quote(input: QuoteInput): Promise<PriceQuote> {
    if (input.quantity !== 1n) throw new TypeError("quantity must equal one");
    const client = this.transactions.requireActiveTransaction(
      input.tenantId,
      "write",
    );
    const revision = await client.billing_feature_price_revision.findFirst({
      where: {
        tenant_id: input.tenantId,
        effective_from: { lte: input.at ?? new Date() },
      },
      orderBy: [{ effective_from: "desc" }, { revision: "desc" }],
    });
    if (!revision)
      throw new MeteringError(
        "PRICE_UNAVAILABLE",
        "No effective pricing revision",
      );
    const price = await client.billing_feature_price.findFirst({
      where: {
        tenant_id: input.tenantId,
        feature_price_revision_id: revision.id,
        feature_key: input.featureKey,
      },
    });
    if (!price)
      throw new MeteringError("PRICE_UNAVAILABLE", "Feature has no price");
    const authorizedMicros = price.unit_price_micros * input.quantity;
    return {
      revisionId: revision.id,
      priceId: price.id,
      featureKey: price.feature_key,
      quantity: input.quantity,
      unitPriceMicros: price.unit_price_micros,
      authorizedMicros,
      mode: authorizedMicros === 0n ? "included" : "credit",
    };
  }
  async recordUsage(input: RecordUsageInput): Promise<string> {
    const client = this.transactions.requireActiveTransaction(
      input.tenantId,
      "write",
    );
    const prior = await client.billing_usage_event.findFirst({
      where: {
        tenant_id: input.tenantId,
        source_event_id: input.sourceEventId,
      },
    });
    if (prior) {
      if (
        prior.subject_id !== input.subjectId ||
        prior.feature_key !== input.featureKey ||
        prior.quantity !== input.quantity ||
        prior.credit_hold_id !== (input.holdId ?? null) ||
        commandDigest({ dimensions: prior.dimensions_json }) !==
          commandDigest({ dimensions: input.dimensions ?? null })
      )
        throw new MeteringError(
          "USAGE_EVENT_MISMATCH",
          "Usage source belongs to another payload",
        );
      return prior.id;
    }
    const id = randomUUID();
    await client.billing_usage_event.create({
      data: {
        id,
        tenant_id: input.tenantId,
        subject_id: input.subjectId,
        source_event_id: input.sourceEventId,
        feature_key: input.featureKey,
        quantity: input.quantity,
        ...(input.dimensions === undefined
          ? {}
          : { dimensions_json: toPersistedJson(input.dimensions) }),
        credit_hold_id: input.holdId ?? null,
      },
    });
    return id;
  }
}
