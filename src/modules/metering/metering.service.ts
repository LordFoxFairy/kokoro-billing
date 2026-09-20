import { randomUUID } from "node:crypto";
import type { TransactionService } from "../../database/transaction.service.js";
import type { CreditEffects } from "../credit/credit.public.js";
import { MeteringError } from "./metering.error.js";
import type { MeteringRepository } from "./metering.repository.js";
import type {
  PriceQuote,
  QuoteInput,
  SettleUsageInput,
  UsageSettlementResult,
} from "./metering.types.js";

export class MeteringService {
  constructor(
    private readonly transactions: TransactionService,
    private readonly repository: MeteringRepository,
    private readonly credit: CreditEffects,
  ) {}
  quote(input: QuoteInput): Promise<PriceQuote> {
    return this.transactions.runRoot(
      {
        tenantId: input.tenantId,
        actorId: "pricing",
        operation: "metering.quote",
        mode: "write",
      },
      () => this.repository.quote(input),
    );
  }
  async settle(input: SettleUsageInput): Promise<UsageSettlementResult> {
    return this.transactions.runRoot(
      {
        tenantId: input.tenantId,
        actorId: input.actorId,
        operation: "metering.settle",
        mode: "write",
      },
      async () => {
        const client = this.transactions.requireActiveTransaction(
          input.tenantId,
          "write",
        );
        const usageEventId = await this.repository.recordUsage({
          tenantId: input.tenantId,
          subjectId: input.subjectId,
          sourceEventId: input.sourceEventId,
          featureKey: input.featureKey,
          quantity: input.quantity,
          ...(input.dimensions === undefined
            ? {}
            : { dimensions: input.dimensions }),
          holdId: input.holdId,
        });
        const terminal = await this.credit.capture({
          tenantId: input.tenantId,
          holdId: input.holdId,
          actualMicros: input.actualMicros,
          sourceRef: usageEventId,
        });
        const durable = await client.billing_usage_settlement.findFirst({
          where: { tenant_id: input.tenantId, credit_hold_id: input.holdId },
        });
        if (
          durable &&
          (durable.usage_event_id !== usageEventId ||
            durable.actual_micros !== input.actualMicros)
        )
          throw new MeteringError(
            "USAGE_EVENT_MISMATCH",
            "Settlement belongs to another usage payload",
          );
        const settlementId = durable?.id ?? randomUUID();
        if (!durable) {
          await client.billing_usage_settlement.create({
            data: {
              id: settlementId,
              tenant_id: input.tenantId,
              credit_hold_id: input.holdId,
              usage_event_id: usageEventId,
              actual_micros: input.actualMicros,
            },
          });
          await client.billing_usage_event.update({
            where: { id: usageEventId },
            data: { status: "settled" },
          });
        }
        return {
          usageEventId,
          settlementId,
          capturedMicros: terminal.capturedMicros,
          releasedMicros: terminal.releasedMicros,
        };
      },
    );
  }
}
